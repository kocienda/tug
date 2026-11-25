/**
 * docket-card.tsx — the Docket card: one docket shown as threads, and the
 * field work is filed on by placing its atom.
 *
 * A docket holds the user's own grouping of work — arcs, sketches, briefs,
 * sessions, commits — and the card draws it as threads, each one the work in
 * the order it ran: sketch, brief, arc, sessions, commits. Every cell is the
 * atom its kind already wears elsewhere in the app, so a thread reads as the
 * same objects the transcript and the shades show.
 *
 * **Filing is placing an atom.** The top row is a one-row `TugMessageEditor`,
 * so paste, drop and the Paste responder are the editor substrate's own
 * doors. When an edit leaves atoms in the field, the fileable ones are sent
 * as one `docket_file`, and the field empties when the answer — or the
 * refusal — arrives, never on send. An ask nothing answers by its deadline
 * leaves the atoms where they are, says so, and Return files them again.
 *
 * **Typing is capturing an idea.** Return on a field holding text and no
 * atoms makes an idea of the line, filed on this docket. Ideas nothing has
 * been made from yet are the docket's inbox, listed first under its label.
 * A thread's gesture strip carries its work forward; Sketch it records a
 * fresh session on the idea and opens a Session card whose first turn is the
 * idea's line.
 *
 * **Every later rung opens a session too.** Keep sketch, Write brief, Revise
 * brief, Open arc and Reopen arc each open a fresh Session card whose first
 * turn is the plugin command that does the work; an arc opened on a brief
 * written from an older sketch asks first. Edit Sketch is the one gesture the
 * card answers itself: its editor keeps the user's text as a new version, and
 * its reader shows an older sketch version or a brief version's snapshot.
 * A stale brief, the brief an arc was opened on, and a sketch the user wrote
 * are said by attributes CSS draws ([L06]).
 *
 * **The record is the feed's, the gesture's outcome is the reply's.** What
 * the card lists is the `DOCKETS` snapshot ([L02]); the CONTROL reply only
 * says how a gesture went, on the quiet line under the field. A live arc's
 * step fraction is the Arcs card's own source, the arc's entry in
 * CHANGESET_ALL, matched by the docket project's `workspace_key` ([L29]), so
 * the two cards cannot disagree about where an arc stands.
 *
 * **Every verb is a vocabulary action the card's responder implements.** The
 * docket chooser's items and a thread row's menu dispatch through the chain
 * ([L30]); none is a callback hidden in a closure.
 *
 * The seed `{ projectDir, docketId, thread? }` rides `addCard`'s initial
 * content and `useCardStatePreservation`; the card writes back its project,
 * docket and "show retired" and never `thread`, which marks one row once.
 *
 * Laws: [L02] dockets and the live arc state enter through
 *       `useSyncExternalStore`; [L03] the open registry registers in a layout
 *       effect; [L06] the marked thread is an attribute CSS fades;
 *       [L24] fold bits and the filing line are local data;
 *       [L29] projects compare by `workspace_key`; [L30] every verb is an
 *       action; [L31] [L33] a filing ends in the act or a visible reason,
 *       bounded by the sender's deadline.
 *
 * @module components/docket/docket-card
 */

import "./docket-card.css";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { ModalInputDialog } from "@/components/chrome/modal-input-dialog";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { TugCommitAtom } from "@/components/tugways/tug-commit-atom";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import {
  TugMessageEditor,
  type TugMessageEditorHandle,
} from "@/components/tugways/tug-message-editor";
import { TugPopupButton, type TugPopupButtonItem } from "@/components/tugways/tug-popup-button";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { dispatchCommand } from "@/command-dispatch";
import type { TugAction } from "@/lib/action-vocabulary";
import {
  DOCKET_GESTURE_LABELS,
  gesturesFor,
  openingFor,
  keptVersionRef,
  needsStaleConfirm,
  parseKeptVersionRef,
  partitionInbox,
  staleConfirmMessage,
  type DocketGesture,
} from "@/lib/docket-authoring";
import { DocketReader, DocketSketchEditor, authorWords } from "./docket-sketch-editor";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-char";
import { type TugEditorContextMenuEntry } from "@/components/tugways/tug-editor-context-menu";
import { getAtomsInState } from "@/components/tugways/tug-text-editor/atom-decoration";
import { SessionCitation } from "@/components/tugways/cards/session-identity";
import { useCardStatePreservation } from "@/components/tugways/use-card-state-preservation";
import { usePointMenu } from "@/components/tugways/use-point-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { arcEntryGlanceFraction } from "@/lib/arc-meta-facts";
import { useChangesetAll } from "@/lib/changeset-all-store";
import type { ArcChangesetEntry, ProjectChangeset } from "@/lib/changeset-types";
import { getConnection } from "@/lib/connection-singleton";
import { useWholeEntityPress } from "@/lib/whole-entity-press";
import {
  getOpenDocketCard,
  registerOpenDocketCard,
  unregisterOpenDocketCard,
  type DocketCardTarget,
} from "@/lib/docket-card-open-registry";
import { fileItemOf, filedItemsOf, filingSentence } from "@/lib/docket-filing";
import { useDockets } from "@/lib/docket-store";
import type {
  DocketEntry,
  DocketThread,
  DocketsSnapshot,
  ProjectDockets,
} from "@/lib/docket-types";
import { docketVerbs, type DocketVerbs } from "@/lib/docket-verbs";
import { copyDocketAtom, docketAtomSegment } from "@/lib/docket-atom";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { TugAtomChip } from "@/lib/tug-atom-chip";
import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import { coerceDocketSeed, type DocketCardBag } from "@/lib/open-docket-in-card";
import { docketShown } from "@/bus/declarations/verbs";
import { page } from "@/bus/page";
import type { DocketFileItem, SketchVersionRow } from "@/protocol";

/** The last path component, which an atom's `<project>/<name>` value leads with. */
function projectLeaf(dir: string): string {
  const parts = dir.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? dir;
}

/** The sessions and commits a folded row shows before it says "+N". */
const FOLDED_SESSIONS = 2;
const FOLDED_COMMITS = 3;

/** The line the card says when the sender's deadline passes. */
export const UNANSWERED_FILING_LINE = "Tug did not answer — nothing was filed";

/** The line the card says when an idea's capture goes unanswered. */
export const UNANSWERED_IDEA_LINE = "Tug did not answer — no idea was added";

/** The line the card says when Sketch it's ask goes unanswered. */
export const UNANSWERED_SESSION_LINE = "Tug did not answer — no session opened";

/** The line the card says when a sketch read goes unanswered. */
export const UNANSWERED_READ_LINE = "Tug did not answer — the sketch was not read";

/** The gestures this card's responder carries out, and the action each dispatches. */
const GESTURE_ACTIONS: Partial<Record<DocketGesture, TugAction>> = {
  "sketch-it": TUG_ACTIONS.SKETCH_IDEA,
  "keep-sketch": TUG_ACTIONS.KEEP_SKETCH,
  "edit-sketch": TUG_ACTIONS.EDIT_SKETCH,
  "write-brief": TUG_ACTIONS.WRITE_BRIEF,
  "revise-brief": TUG_ACTIONS.REVISE_BRIEF,
  "open-arc": TUG_ACTIONS.OPEN_ARC_ON_BRIEF,
  "reopen-arc": TUG_ACTIONS.REOPEN_ARC_ON_BRIEF,
};

/** The gestures `thread` offers that the card can carry out, in strip order. */
function cardGestures(thread: DocketThread): DocketGesture[] {
  return gesturesFor(thread).filter((g) => GESTURE_ACTIONS[g] !== undefined);
}

/** The open project section of CHANGESET_ALL whose workspace key is `key`. */
function changesetProjectFor(
  projects: readonly ProjectChangeset[],
  key: string,
): ProjectChangeset | null {
  return projects.find((p) => p.workspace_key === key) ?? null;
}

/** The live arc's entry in CHANGESET_ALL, by name within its project. */
function arcEntryFor(project: ProjectChangeset | null, name: string): ArcChangesetEntry | null {
  if (project === null) return null;
  for (const entry of project.changesets) {
    if (entry.kind === "arc" && entry.display_name === name) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The thread list
// ---------------------------------------------------------------------------

/** One row of the list: the inbox's label, or a thread. */
type DocketRow = { kind: "label" } | { kind: "thread"; thread: DocketThread };

/** The rows a docket draws: its inbox under a label, newest first, then the rest. */
function docketRows(threads: readonly DocketThread[]): DocketRow[] {
  const { inbox, rest } = partitionInbox(threads);
  const rows: DocketRow[] = [];
  if (inbox.length > 0) rows.push({ kind: "label" });
  for (const thread of inbox) rows.push({ kind: "thread", thread });
  for (const thread of rest) rows.push({ kind: "thread", thread });
  return rows;
}

/** A flat, immutable source over one render's rows. */
class DocketThreadSource implements TugListViewDataSource {
  constructor(
    readonly rows: readonly DocketRow[],
    readonly projectDir: string,
    readonly arcProject: ProjectChangeset | null,
    readonly open: ReadonlySet<string>,
  ) {}
  numberOfItems(): number {
    return this.rows.length;
  }
  idForIndex(index: number): string {
    const row = this.rows[index]!;
    return row.kind === "label" ? "docket-inbox-label" : row.thread.key;
  }
  kindForIndex(index: number): string {
    return this.rows[index]!.kind;
  }
  roleForIndex(index: number): "cell" | "header" {
    return this.rows[index]?.kind === "label" ? "header" : "cell";
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return this;
  }
}

/** A row's arc cell: the pill and the state its fate reads. */
function ArcCell({
  thread,
  arcProject,
}: {
  thread: DocketThread;
  arcProject: ProjectChangeset | null;
}): React.ReactElement | null {
  const arc = thread.arc;
  if (arc === null || arc === undefined) return null;
  let state: React.ReactNode = null;
  if (arc.fate === "live") {
    const entry = arcEntryFor(arcProject, arc.name);
    const fraction = entry !== null ? arcEntryGlanceFraction(entry) : null;
    state = (
      <span className="docket-arc-state" data-slot="docket-arc-fraction">
        {fraction !== null ? `${fraction.current}/${fraction.total}` : "live"}
      </span>
    );
  } else if (arc.fate === "joined") {
    state =
      typeof arc.join_sha === "string" && arc.join_sha.length > 0 ? (
        <TugCommitAtom sha={arc.join_sha} data-slot="docket-arc-join" />
      ) : (
        <span className="docket-arc-state">joined</span>
      );
  } else {
    state = (
      <span className="docket-arc-state" data-slot="docket-arc-fate">
        discarded
      </span>
    );
  }
  const briefVersions = thread.brief?.versions ?? 0;
  const onBrief =
    typeof arc.brief_version === "number" && briefVersions > 0
      ? `on brief v${arc.brief_version} of ${briefVersions}`
      : null;
  const runs = arc.runs ?? 1;
  return (
    <span
      className="docket-cell docket-cell-arc"
      data-slot="docket-arc-cell"
      data-fate={arc.fate}
      data-stale={arc.stale === true ? "true" : undefined}
    >
      <TugArcAtom name={arc.name} />
      {state}
      {onBrief !== null ? (
        <span className="docket-cell-note" data-slot="docket-arc-brief">
          {onBrief}
        </span>
      ) : null}
      {runs > 1 ? (
        <span className="docket-cell-note" data-slot="docket-arc-runs">{`${runs} runs`}</span>
      ) : null}
    </span>
  );
}

/**
 * A row's brief cell: the brief, and — when it is a version kept on the
 * thread's sketch — a note naming the version, which opens a popup of every
 * kept brief version. A brief written from an older sketch version is marked
 * stale, and its title says from which.
 */
function BriefCell({ thread }: { thread: DocketThread }): React.ReactElement | null {
  const brief = thread.brief;
  if (brief === undefined || brief === null) return null;
  const stale = brief.stale === true;
  const version = typeof brief.version === "number" ? brief.version : null;
  const sketch = thread.sketch ?? null;
  const count = brief.versions ?? 0;
  const items: TugPopupButtonItem<string>[] =
    sketch === null
      ? []
      : Array.from({ length: count }, (_, i) => count - i).map((n) => ({
          action: TUG_ACTIONS.READ_BRIEF_VERSION,
          value: keptVersionRef(sketch.id, n),
          label: `Brief v${n}`,
        }));
  const note = version === null ? null : `v${version}${stale ? " · stale" : ""}`;
  const title =
    stale && typeof brief.sketch_version === "number" && sketch !== null
      ? `Written from sketch v${brief.sketch_version}; the sketch is now v${sketch.versions}`
      : undefined;
  return (
    <span
      className="docket-cell"
      data-slot="docket-brief-cell"
      data-stale={stale ? "true" : undefined}
      title={title}
    >
      {typeof brief.source_path === "string" ? (
        <TugAtomChip
          type="file"
          label={brief.title ?? brief.source_path}
          value={brief.source_path}
          maxLabelWidth={220}
        />
      ) : (
        <span className="docket-brief-title">{brief.title ?? "Brief"}</span>
      )}
      {note !== null ? (
        items.length > 0 ? (
          <span className="docket-brief-versions" data-slot="docket-brief-versions">
            <TugPopupButton size="2xs" label={note} items={items} />
          </span>
        ) : (
          <span className="docket-cell-note" data-slot="docket-brief-versions">
            {note}
          </span>
        )
      ) : null}
    </span>
  );
}

/**
 * A thread's gesture strip: one small button per gesture the card carries
 * out, each dispatched to the card's responder with the thread's key.
 */
function DocketGestureStrip({ thread }: { thread: DocketThread }): React.ReactElement | null {
  const { dispatch } = useControlDispatch();
  const gestures = cardGestures(thread);
  if (gestures.length === 0) return null;
  return (
    <span className="docket-thread-gestures" data-slot="docket-thread-gestures">
      {gestures.map((gesture) => (
        <TugPushButton
          key={gesture}
          size="2xs"
          emphasis="ghost"
          data-tug-focus="refuse"
          data-gesture={gesture}
          onClick={(event) => {
            // The row is a door of its own (it folds); this press is not.
            event?.stopPropagation();
            event?.preventDefault();
            dispatch({ action: GESTURE_ACTIONS[gesture]!, value: thread.key, phase: "discrete" });
          }}
        >
          {DOCKET_GESTURE_LABELS[gesture]}
        </TugPushButton>
      ))}
    </span>
  );
}

const DocketInboxLabel: TugListViewCellRenderer<DocketThreadSource> = () => (
  <TugSectionLabel label={{ name: "Inbox" }} data-slot="docket-inbox-label" />
);

const DocketThreadCell: TugListViewCellRenderer<DocketThreadSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<DocketThreadSource>) => {
  const row = dataSource.rows[index];
  if (row === undefined || row.kind !== "thread") return null;
  const thread = row.thread;
  const open = dataSource.open.has(thread.key);
  const sessions = open ? thread.sessions : thread.sessions.slice(0, FOLDED_SESSIONS);
  const commits = open ? thread.commits : thread.commits.slice(0, FOLDED_COMMITS);
  const hidden =
    thread.sessions.length - sessions.length + (thread.commits.length - commits.length);
  const leaf = projectLeaf(dataSource.projectDir);
  return (
    <TugListRow
      variant="flush"
      density="compact"
      data-slot="docket-thread-row"
      data-thread-key={thread.key}
      data-open={open ? "true" : undefined}
    >
      <span className="docket-thread-cells">
        {thread.idea ? (
          <span className="docket-cell docket-cell-idea" data-slot="docket-idea-cell">
            {thread.idea.text}
          </span>
        ) : null}
        {thread.sketch ? (
          <span
            className="docket-cell"
            data-slot="docket-sketch-cell"
            data-author={thread.sketch.author === "user" ? "user" : undefined}
          >
            <TugAtomChip
              type="sketch"
              label={thread.sketch.want ?? thread.sketch.id}
              value={thread.sketch.id}
              sketch={{ projectDir: dataSource.projectDir }}
              maxLabelWidth={220}
            />
            {thread.sketch.versions > 1 ? (
              <span className="docket-cell-note">{`v${thread.sketch.versions}`}</span>
            ) : null}
            {thread.sketch.author === "user" ? (
              <span className="docket-cell-note" data-slot="docket-sketch-author">
                yours
              </span>
            ) : null}
          </span>
        ) : null}
        <BriefCell thread={thread} />
        <ArcCell thread={thread} arcProject={dataSource.arcProject} />
        {sessions.map((session) => (
          <span key={session.uuid} className="docket-cell" data-slot="docket-session-cell">
            <SessionCitation
              citedId={session.uuid}
              recordedTag={session.callsign ? `${leaf}/${session.callsign}` : null}
            />
            {session.stage ? <span className="docket-cell-note">{session.stage}</span> : null}
          </span>
        ))}
        {commits.map((commit) => (
          <span
            key={commit.sha}
            className="docket-cell"
            data-slot="docket-commit-cell"
            title={commit.subject}
          >
            <TugCommitAtom sha={commit.sha} />
          </span>
        ))}
        {hidden > 0 ? (
          <span className="docket-cell-more" data-slot="docket-thread-more">{`+${hidden}`}</span>
        ) : null}
      </span>
      <DocketGestureStrip thread={thread} />
    </TugListRow>
  );
};

const THREAD_CELL_RENDERERS = { label: DocketInboxLabel, thread: DocketThreadCell };

// ---------------------------------------------------------------------------
// The name dialog
// ---------------------------------------------------------------------------

/**
 * A name asked for in the app's input dialog: its one row echoes what was
 * typed, so Return on it commits the name, and an empty field offers nothing.
 */
function DocketNameDialog({
  placeholder,
  verb,
  onCommit,
  onDismiss,
}: {
  placeholder: string;
  verb: string;
  onCommit: (name: string) => void;
  onDismiss: () => void;
}): React.ReactElement {
  const provider = useMemo<CompletionProvider>(
    () => (query: string): CompletionItem[] => {
      const name = query.trim();
      if (name.length === 0) return [];
      const atom: AtomSegment = { kind: "atom", type: "text", label: name, value: name };
      return [{ label: `${verb} “${name}”`, atom }];
    },
    [verb],
  );
  return (
    <ModalInputDialog
      placeholder={placeholder}
      provider={provider}
      onCommit={(item) => onCommit(item.atom.value)}
      onDismiss={onDismiss}
      dismissOnOutsideClick
    />
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** The dockets the chooser lists: unretired, then retired when asked. */
function chooserDockets(project: ProjectDockets | null, showRetired: boolean): DocketEntry[] {
  if (project === null) return [];
  const live = project.dockets.filter((d) => !d.retired);
  if (!showRetired) return live;
  return [...live, ...project.dockets.filter((d) => d.retired)];
}

export function DocketCardContent({ cardId }: { cardId: string }): React.ReactElement {
  const snapshot: DocketsSnapshot = useDockets();
  const changesets = useChangesetAll();

  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [docketId, setDocketId] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [filingLine, setFilingLine] = useState<string | null>(null);
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The thread to mark, once. A ref: it is consumed by a layout effect and
  // never drawn from React state.
  const pendingThreadRef = useRef<string | null>(null);
  const [markGeneration, setMarkGeneration] = useState(0);
  // The sketch whose editor an open asked for, once; consumed like the
  // thread, when the sketch's thread is in the snapshot and the sender is up.
  const pendingEditRef = useRef<string | null>(null);
  const [editGeneration, setEditGeneration] = useState(0);
  // What the body shows: the threads, the sketch editor, or the reader.
  const [view, setView] = useState<DocketView>(THREADS_VIEW);
  const [verbsReady, setVerbsReady] = useState(false);
  // An arc gesture on a stale brief, waiting on the confirm.
  const [staleAsk, setStaleAsk] = useState<{
    key: string;
    gesture: DocketGesture;
    message: string;
    anchor: HTMLElement | null;
  } | null>(null);

  useCardStatePreservation<DocketCardBag | undefined>({
    onSave: () => ({
      ...(projectDir !== null ? { projectDir } : {}),
      ...(docketId !== null ? { docketId } : {}),
      ...(showRetired ? { showRetired: true } : {}),
    }),
    onRestore: (state) => {
      const seed = coerceDocketSeed(state);
      if (seed === null) return;
      setSeeded(seed.projectDir !== undefined);
      if (seed.projectDir !== undefined) setProjectDir(seed.projectDir);
      if (seed.docketId !== undefined) setDocketId(seed.docketId);
      if (seed.showRetired === true) setShowRetired(true);
      if (seed.thread !== undefined) {
        pendingThreadRef.current = seed.thread;
        setMarkGeneration((g) => g + 1);
      }
      if (seed.editSketch !== undefined) {
        pendingEditRef.current = seed.editSketch;
        setEditGeneration((g) => g + 1);
      }
    },
  });

  // The project shown: the chosen one, or the only open project when there
  // is exactly one and nothing was chosen.
  const openProjects = changesets.projects;
  const effectiveProjectDir =
    projectDir ?? (openProjects.length === 1 ? openProjects[0]!.project_dir : null);
  const docketProject =
    effectiveProjectDir === null
      ? null
      : (snapshot.projects.find((p) => p.project_dir === effectiveProjectDir) ?? null);
  const arcProject =
    docketProject === null
      ? null
      : changesetProjectFor(openProjects, docketProject.workspace_key);
  const dockets = chooserDockets(docketProject, showRetired);
  // A retired docket is shown only while retired dockets are: retiring the
  // one on screen takes it out of the chooser and off the card together.
  const chosen =
    docketProject === null || docketId === null
      ? null
      : (docketProject.dockets.find((d) => d.id === docketId) ?? null);
  const docket = chosen !== null && (!chosen.retired || showRetired) ? chosen : null;

  // Tell the shell which docket this card shows, so an open of it finds this
  // card: a body card's bag is this page's, and the shell's copy is the seed.
  const shownDir = docket !== null ? effectiveProjectDir : null;
  const shownId = docket?.id ?? null;
  useEffect(() => {
    if (!page.isBody) return;
    docketShown.dispatch({ projectDir: shownDir ?? "", docketId: shownId ?? "" });
  }, [shownDir, shownId]);

  // Live reads for the verbs, which run from the responder chain ([L07]).
  const liveRef = useRef({ effectiveProjectDir, docket, docketProject, snapshot });
  liveRef.current = { effectiveProjectDir, docket, docketProject, snapshot };

  // The sender lives as long as the card.
  const verbsRef = useRef<DocketVerbs | null>(null);
  useEffect(() => {
    const connection = getConnection();
    if (connection === null) return;
    const verbs = docketVerbs(connection);
    verbsRef.current = verbs;
    setVerbsReady(true);
    return () => {
      verbs.dispose();
      if (verbsRef.current === verbs) verbsRef.current = null;
    };
  }, []);

  // Open registry: reuse by `(projectDir, docketId)`.
  useLayoutEffect(() => {
    registerOpenDocketCard(cardId, {
      getTarget: () => {
        const { effectiveProjectDir: dir, docket: d } = liveRef.current;
        return dir !== null && d !== null ? { projectDir: dir, docketId: d.id } : null;
      },
      setTarget: (next: DocketCardTarget) => {
        setProjectDir(next.projectDir);
        setDocketId(next.docketId);
        setSeeded(true);
        if (next.thread !== undefined) {
          pendingThreadRef.current = next.thread;
          setMarkGeneration((g) => g + 1);
        }
        if (next.editSketch !== undefined) {
          pendingEditRef.current = next.editSketch;
          setEditGeneration((g) => g + 1);
        }
      },
    });
    return () => unregisterOpenDocketCard(cardId);
  }, [cardId]);

  // ---- Filing ----

  const editorRef = useRef<TugMessageEditorHandle | null>(null);
  const fieldAtomsRef = useRef<readonly AtomSegment[]>([]);
  // The field's text with its atoms taken out: what Return makes an idea of.
  const fieldTextRef = useRef("");
  const filingRef = useRef(false);

  const captureIdea = useCallback((text: string): void => {
    const { effectiveProjectDir: dir, docket: d } = liveRef.current;
    if (dir === null || d === null) {
      setFilingLine("Choose or create a docket to file on");
      return;
    }
    const verbs = verbsRef.current;
    if (verbs === null) {
      setFilingLine(UNANSWERED_IDEA_LINE);
      return;
    }
    filingRef.current = true;
    setFilingLine(null);
    void verbs.ideaCreate({ projectDir: dir, docketId: d.id, text }).then((result) => {
      filingRef.current = false;
      if (result.kind === "unanswered") {
        setFilingLine(UNANSWERED_IDEA_LINE);
        return;
      }
      editorRef.current?.clear();
      fieldAtomsRef.current = [];
      fieldTextRef.current = "";
      if (result.kind === "refused") {
        setFilingLine(result.message);
        return;
      }
      // The idea is kept even when the docket refused it; say why.
      const outcome = result.reply.outcome;
      setFilingLine(
        outcome.outcome === "refused"
          ? (outcome.reason ?? "The idea was kept but not filed")
          : null,
      );
    });
  }, []);

  const fileField = useCallback((): void => {
    const segments = fieldAtomsRef.current;
    if (filingRef.current) return;
    if (segments.length === 0) {
      const text = fieldTextRef.current;
      if (text.length > 0) captureIdea(text);
      return;
    }
    const { effectiveProjectDir: dir, docket: d, docketProject: p } = liveRef.current;
    if (dir === null || d === null) {
      setFilingLine("Choose or create a docket to file on");
      return;
    }
    const items: DocketFileItem[] = [];
    const refused: string[] = [];
    for (const segment of segments) {
      const item = fileItemOf(segment, dir);
      if (item === null) refused.push(segment.type);
      else items.push(item);
    }
    const refusedClause =
      refused.length === 0
        ? ""
        : `${refused.length} not fileable: ${[...new Set(refused)].join(", ")}`;
    if (items.length === 0) {
      editorRef.current?.clear();
      fieldAtomsRef.current = [];
      setFilingLine(refusedClause);
      return;
    }
    const verbs = verbsRef.current;
    if (verbs === null) {
      setFilingLine(UNANSWERED_FILING_LINE);
      return;
    }
    filingRef.current = true;
    setFilingLine(null);
    const names = new Map((p?.dockets ?? []).map((x) => [x.id, x.name] as const));
    void verbs.file({ projectDir: dir, id: d.id, items }).then((result) => {
      filingRef.current = false;
      if (result.kind === "unanswered") {
        setFilingLine(UNANSWERED_FILING_LINE);
        return;
      }
      editorRef.current?.clear();
      fieldAtomsRef.current = [];
      const said =
        result.kind === "ok" ? filingSentence(result.reply.outcomes, names) : result.message;
      setFilingLine([said, refusedClause].filter((s) => s.length > 0).join(" · "));
    });
  }, [captureIdea]);

  // The field's atoms, read whole — with each atom's session and arc
  // identity — off the editor state on every user edit. The substrate the
  // editor's `onChange` reports carries an atom's type and value only, and a
  // session or arc atom pasted from another checkout files by the identity it
  // carried.
  const fileFieldRef = useRef(fileField);
  fileFieldRef.current = fileField;
  const fieldExtensions = useMemo(
    () => [
      // Return is the field's submit: it captures the typed line as an idea,
      // or files the atoms again. The editor beneath keeps Cmd-Return too.
      Prec.high(
        keymap.of([
          {
            key: "Enter",
            run: () => {
              fileFieldRef.current();
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        fieldAtomsRef.current = getAtomsInState(update.state).map((a) => a.segment);
        fieldTextRef.current = update.state.doc.toString().split(TUG_ATOM_CHAR).join("").trim();
        const userEdit = update.transactions.some(
          (t) =>
            (t.isUserEvent("input") || t.isUserEvent("delete") || t.isUserEvent("undo") ||
              t.isUserEvent("redo")) &&
            !t.isUserEvent("delete.tug-clear"),
        );
        if (userEdit && fieldAtomsRef.current.length > 0) fileFieldRef.current();
      }),
    ],
    [],
  );

  // ---- Verbs ----

  const send = useCallback(
    (run: (verbs: DocketVerbs, dir: string) => Promise<{ kind: string; message?: string }>) => {
      const verbs = verbsRef.current;
      const dir = liveRef.current.effectiveProjectDir;
      if (verbs === null || dir === null) return;
      void run(verbs, dir).then((result) => {
        if (result.kind === "refused") setFilingLine(result.message ?? "");
        else if (result.kind === "unanswered") setFilingLine("Tug did not answer");
      });
    },
    [],
  );

  // ---- Authoring ----

  // Open a fresh Session card whose first turn is `gesture`'s opening.
  const openGesture = useCallback(
    (gesture: DocketGesture, key: string): void => {
      const { docket: d, effectiveProjectDir: dir } = liveRef.current;
      if (d === null || dir === null) return;
      const thread = d.threads.find((t) => t.key === key);
      if (thread === undefined || !gesturesFor(thread).includes(gesture)) return;
      const opening = openingFor(gesture, thread);
      if (opening === null) return;
      setFilingLine(null);
      dispatchCommand(TUG_ACTIONS.OPEN_AUTHORING_SESSION, {
        projectDir: dir,
        sessionId: crypto.randomUUID(),
        opening,
        originCardId: cardId,
      });
    },
    [cardId],
  );

  // An arc gesture: on a stale brief, ask first, anchored on the row's strip.
  const openArcGesture = useCallback(
    (gesture: DocketGesture, key: string): void => {
      const thread = liveRef.current.docket?.threads.find((t) => t.key === key);
      if (thread === undefined) return;
      if (!needsStaleConfirm(gesture, thread)) {
        openGesture(gesture, key);
        return;
      }
      const index = rowsRef.current.findIndex((r) => r.kind === "thread" && r.thread.key === key);
      const rowEl = index === -1 ? null : (listRef.current?.getElementForIndex(index) ?? null);
      const anchor =
        rowEl?.querySelector<HTMLElement>('[data-slot="docket-thread-gestures"]') ?? rowEl;
      setStaleAsk({ key, gesture, message: staleConfirmMessage(thread), anchor });
    },
    [openGesture],
  );

  // Read a sketch's latest version into the editor.
  const enterEditor = useCallback((id: string): void => {
    const verbs = verbsRef.current;
    const dir = liveRef.current.effectiveProjectDir;
    if (verbs === null || dir === null) return;
    void verbs.sketchRead({ projectDir: dir, id }).then((result) => {
      if (result.kind === "ok") {
        setView({
          kind: "edit-sketch",
          id,
          base: result.reply.version,
          text: result.reply.text,
          versions: result.reply.versions,
        });
      } else if (result.kind === "refused") setFilingLine(result.message);
      else setFilingLine(UNANSWERED_READ_LINE);
    });
  }, []);

  // Read one kept text into the reader: a sketch version, or a brief version.
  const readKept = useCallback(
    (id: string, which: { version: number } | { brief: number }): void => {
      const verbs = verbsRef.current;
      const dir = liveRef.current.effectiveProjectDir;
      if (verbs === null || dir === null) return;
      void verbs.sketchRead({ projectDir: dir, id, ...which }).then((result) => {
        if (result.kind === "ok") {
          const reply = result.reply;
          let title: string;
          if ("brief" in which) {
            const row = reply.briefs.find((b) => b.n === which.brief);
            title =
              row !== undefined && row.title.length > 0
                ? `Brief v${which.brief} · ${row.title}`
                : `Brief v${which.brief}`;
          } else {
            const row = reply.versions.find((v) => v.n === which.version);
            title = `Sketch v${which.version} · ${authorWords(row?.author)}`;
          }
          setView({ kind: "read", title, text: reply.text });
        } else if (result.kind === "refused") setFilingLine(result.message);
        else setFilingLine(UNANSWERED_READ_LINE);
      });
    },
    [],
  );

  const chooserRef = useRef<HTMLDivElement | null>(null);

  const responderId = React.useId();
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.SELECT_DOCKET_PROJECT]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        setProjectDir(event.value);
        setDocketId(null);
        setFilingLine(null);
        setView(THREADS_VIEW);
      },
      [TUG_ACTIONS.SELECT_DOCKET]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        setDocketId(event.value);
        setFilingLine(null);
        setView(THREADS_VIEW);
      },
      [TUG_ACTIONS.NEW_DOCKET]: () => setNaming("new"),
      [TUG_ACTIONS.RENAME_DOCKET]: () => {
        if (liveRef.current.docket !== null) setNaming("rename");
      },
      [TUG_ACTIONS.REQUEST_RETIRE_DOCKET]: () => {
        if (liveRef.current.docket !== null) setConfirmingRetire(true);
      },
      [TUG_ACTIONS.RESTORE_DOCKET]: () => {
        const d = liveRef.current.docket;
        if (d === null) return;
        send((verbs, dir) => verbs.retire({ projectDir: dir, id: d.id, retired: false }));
      },
      [TUG_ACTIONS.TOGGLE_RETIRED_DOCKETS]: () => setShowRetired((v) => !v),
      [TUG_ACTIONS.COPY_DOCKET_ATOM]: () => {
        const { docket: d, effectiveProjectDir: dir } = liveRef.current;
        if (d === null || dir === null) return;
        copyDocketAtom(docketAtomSegment({ id: d.id, name: d.name, projectDir: dir }));
      },
      [TUG_ACTIONS.MOVE_THREAD_TO_DOCKET]: (event: ActionEvent) => {
        const value = event.value as { thread?: unknown; docketId?: unknown } | undefined;
        const { docket: d, effectiveProjectDir: dir, docketProject: p } = liveRef.current;
        if (d === null || dir === null || typeof value?.docketId !== "string") return;
        const thread = d.threads.find((t) => t.key === value.thread);
        if (thread === undefined) return;
        const { items } = filedItemsOf(thread, dir);
        if (items.length === 0) return;
        const verbs = verbsRef.current;
        if (verbs === null) return;
        const names = new Map((p?.dockets ?? []).map((x) => [x.id, x.name] as const));
        void verbs
          .file({ projectDir: dir, id: value.docketId, items })
          .then((result) => {
            if (result.kind === "ok") setFilingLine(filingSentence(result.reply.outcomes, names));
            else if (result.kind === "refused") setFilingLine(result.message);
            else setFilingLine("Tug did not answer — nothing was moved");
          });
      },
      [TUG_ACTIONS.SKETCH_IDEA]: (event: ActionEvent) => {
        const { docket: d, effectiveProjectDir: dir } = liveRef.current;
        if (d === null || dir === null) return;
        const thread = d.threads.find((t) => t.key === event.value);
        const idea = thread?.idea ?? null;
        if (thread === undefined || idea === null) return;
        if (!gesturesFor(thread).includes("sketch-it")) return;
        const opening = openingFor("sketch-it", thread);
        if (opening === null) return;
        const verbs = verbsRef.current;
        if (verbs === null) {
          setFilingLine(UNANSWERED_SESSION_LINE);
          return;
        }
        // The card mints the session's id so the idea names the session
        // before the session exists; a refusal or silence opens nothing.
        const sessionId = crypto.randomUUID();
        void verbs.ideaAddSession({ projectDir: dir, id: idea.id, uuid: sessionId }).then((result) => {
          if (result.kind === "unanswered") {
            setFilingLine(UNANSWERED_SESSION_LINE);
            return;
          }
          if (result.kind === "refused") {
            setFilingLine(result.message);
            return;
          }
          setFilingLine(null);
          dispatchCommand(TUG_ACTIONS.OPEN_AUTHORING_SESSION, {
            projectDir: dir,
            sessionId,
            opening,
            originCardId: cardId,
          });
        });
      },
      [TUG_ACTIONS.KEEP_SKETCH]: (event: ActionEvent) => {
        if (typeof event.value === "string") openGesture("keep-sketch", event.value);
      },
      [TUG_ACTIONS.WRITE_BRIEF]: (event: ActionEvent) => {
        if (typeof event.value === "string") openGesture("write-brief", event.value);
      },
      [TUG_ACTIONS.REVISE_BRIEF]: (event: ActionEvent) => {
        if (typeof event.value === "string") openGesture("revise-brief", event.value);
      },
      [TUG_ACTIONS.OPEN_ARC_ON_BRIEF]: (event: ActionEvent) => {
        if (typeof event.value === "string") openArcGesture("open-arc", event.value);
      },
      [TUG_ACTIONS.REOPEN_ARC_ON_BRIEF]: (event: ActionEvent) => {
        if (typeof event.value === "string") openArcGesture("reopen-arc", event.value);
      },
      [TUG_ACTIONS.EDIT_SKETCH]: (event: ActionEvent) => {
        const thread = liveRef.current.docket?.threads.find((t) => t.key === event.value);
        const sketch = thread?.sketch ?? null;
        if (sketch !== null) enterEditor(sketch.id);
      },
      [TUG_ACTIONS.READ_SKETCH_VERSION]: (event: ActionEvent) => {
        const ref = parseKeptVersionRef(event.value);
        if (ref !== null) readKept(ref.id, { version: ref.n });
      },
      [TUG_ACTIONS.READ_BRIEF_VERSION]: (event: ActionEvent) => {
        const ref = parseKeptVersionRef(event.value);
        if (ref !== null) readKept(ref.id, { brief: ref.n });
      },
      [TUG_ACTIONS.REMOVE_THREAD_FROM_DOCKET]: (event: ActionEvent) => {
        const { docket: d, effectiveProjectDir: dir } = liveRef.current;
        if (d === null || dir === null) return;
        const thread = d.threads.find((t) => t.key === event.value);
        if (thread === undefined) return;
        const { keys } = filedItemsOf(thread, dir);
        if (keys.length === 0) return;
        send((verbs, root) => verbs.remove({ projectDir: root, id: d.id, keys }));
      },
    },
  });

  // ---- The name dialog's commit ----

  const commitName = useCallback(
    (name: string): void => {
      const mode = naming;
      setNaming(null);
      const verbs = verbsRef.current;
      const dir = liveRef.current.effectiveProjectDir;
      if (verbs === null || dir === null || mode === null) return;
      if (mode === "new") {
        void verbs.create({ projectDir: dir, name }).then((result) => {
          if (result.kind === "ok") {
            setProjectDir(dir);
            setDocketId(result.reply.docket.id);
            setFilingLine(null);
          } else if (result.kind === "refused") setFilingLine(result.message);
          else setFilingLine("Tug did not answer — no docket was created");
        });
        return;
      }
      const d = liveRef.current.docket;
      if (d === null) return;
      send((v, root) => v.rename({ projectDir: root, id: d.id, name }));
    },
    [naming, send],
  );

  // ---- The thread list ----

  const listRef = useRef<TugListViewHandle | null>(null);
  const threads = docket?.threads ?? NO_THREADS;
  const rows = useMemo(() => docketRows(threads), [threads]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const source = useMemo(
    () => new DocketThreadSource(rows, effectiveProjectDir ?? "", arcProject, open),
    [rows, effectiveProjectDir, arcProject, open],
  );
  const toggleFold = useCallback((key: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onActivate: (index: number) => {
        const row = rows[index];
        if (row !== undefined && row.kind === "thread") toggleFold(row.thread.key);
      },
    }),
    [rows, toggleFold],
  );

  // Mark the thread an open asked for: scroll it into view and set the
  // attribute CSS fades ([L06]). Runs when the docket's threads arrive.
  useLayoutEffect(() => {
    const key = pendingThreadRef.current;
    if (key === null) return;
    const index = rows.findIndex((r) => r.kind === "thread" && r.thread.key === key);
    if (index === -1) return;
    pendingThreadRef.current = null;
    const list = listRef.current;
    if (list === null) return;
    list.scrollToIndex(index, { block: "center" });
    const mark = (): boolean => {
      const el = list.getElementForIndex(index);
      if (el === null) return false;
      el.closest("[data-docket-list]")
        ?.querySelectorAll("[data-focused]")
        .forEach((other) => other.removeAttribute("data-focused"));
      el.setAttribute("data-focused", "true");
      return true;
    };
    if (!mark()) requestAnimationFrame(() => void mark());
  }, [rows, markGeneration]);

  // Enter the editor an open asked for, once the sketch's thread has arrived
  // and the sender is up to read it.
  useLayoutEffect(() => {
    const id = pendingEditRef.current;
    if (id === null || !verbsReady) return;
    if (!threads.some((t) => t.sketch?.id === id)) return;
    pendingEditRef.current = null;
    enterEditor(id);
  }, [threads, editGeneration, verbsReady, enterEditor]);

  // ---- The row menu ----

  const { openAtEvent, renderMenu, anchor } = usePointMenu<string>();
  // The press that opens a row's menu selects the thread whole — its lead
  // atom when it has one, else the row — the one rule every menu about an
  // entity is under (`lib/whole-entity-press`).
  const { attach: attachPress } = useWholeEntityPress((event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>("[data-thread-key]") ?? null;
    if (row === null) return null;
    return row.querySelector<HTMLElement>("[data-atom-type]") ?? row;
  });
  const onListContextMenu = useCallback(
    (e: React.MouseEvent): void => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-thread-key]");
      const key = row?.dataset.threadKey;
      if (key === undefined) return;
      openAtEvent(e, key);
    },
    [openAtEvent],
  );
  const menuItems = useMemo<TugEditorContextMenuEntry[]>(() => {
    const key = anchor?.target;
    if (key === undefined || docket === null || docketProject === null) return [];
    const targets = docketProject.dockets.filter((d) => !d.retired && d.id !== docket.id);
    const entries: TugEditorContextMenuEntry[] = [];
    const thread = docket.threads.find((t) => t.key === key);
    const gestures = thread === undefined ? [] : cardGestures(thread);
    for (const gesture of gestures) {
      entries.push({ action: GESTURE_ACTIONS[gesture]!, value: key, label: DOCKET_GESTURE_LABELS[gesture] });
    }
    if (gestures.length > 0) entries.push({ type: "separator" });
    if (targets.length > 0) {
      entries.push({ type: "label", label: "Move to Docket" });
      for (const target of targets) {
        entries.push({
          action: TUG_ACTIONS.MOVE_THREAD_TO_DOCKET,
          value: { thread: key, docketId: target.id },
          label: target.name,
        });
      }
      entries.push({ type: "separator" });
    }
    entries.push({
      action: TUG_ACTIONS.REMOVE_THREAD_FROM_DOCKET,
      value: key,
      label: "Remove from Docket",
    });
    return entries;
  }, [anchor, docket, docketProject]);

  // ---- The header's choosers ----

  const projectItems = useMemo<TugPopupButtonItem<string>[]>(
    () =>
      openProjects.map((p) => ({
        action: TUG_ACTIONS.SELECT_DOCKET_PROJECT,
        value: p.project_dir,
        label: p.display_name,
      })),
    [openProjects],
  );
  const docketItems = useMemo<TugPopupButtonItem<string>[]>(() => {
    const items: TugPopupButtonItem<string>[] = dockets.map((d) => ({
      action: TUG_ACTIONS.SELECT_DOCKET,
      value: d.id,
      label: d.retired ? `${d.name} (retired)` : d.name,
    }));
    items.push({ action: TUG_ACTIONS.NEW_DOCKET, label: "New Docket…" });
    if (docket !== null) {
      items.push({ action: TUG_ACTIONS.COPY_DOCKET_ATOM, label: "Copy as Atom" });
      items.push({ action: TUG_ACTIONS.RENAME_DOCKET, label: "Rename…" });
      items.push(
        docket.retired
          ? { action: TUG_ACTIONS.RESTORE_DOCKET, label: "Restore" }
          : { action: TUG_ACTIONS.REQUEST_RETIRE_DOCKET, label: "Retire…" },
      );
    }
    items.push({
      action: TUG_ACTIONS.TOGGLE_RETIRED_DOCKETS,
      label: showRetired ? "Hide Retired" : "Show Retired",
    });
    return items;
  }, [dockets, docket, showRetired]);

  const projectName =
    openProjects.find((p) => p.project_dir === effectiveProjectDir)?.display_name ??
    (effectiveProjectDir !== null ? projectLeaf(effectiveProjectDir) : "Choose a Project");
  const showProjectChooser = openProjects.length > 1 || (!seeded && effectiveProjectDir === null);

  let body: React.ReactNode;
  if (effectiveProjectDir === null) {
    body = <TugEmptyLine data-slot="docket-empty">No project</TugEmptyLine>;
  } else if (docket === null) {
    body = (
      <TugEmptyLine data-slot="docket-empty">
        {dockets.length === 0 ? "No dockets" : "Choose a docket"}
      </TugEmptyLine>
    );
  } else if (view.kind === "edit-sketch") {
    body = (
      <DocketSketchEditor
        key={`${view.id}@${view.base}`}
        projectDir={effectiveProjectDir}
        sketchId={view.id}
        baseVersion={view.base}
        text={view.text}
        versions={view.versions}
        verbs={verbsRef.current}
        onDone={() => setView(THREADS_VIEW)}
      />
    );
  } else if (view.kind === "read") {
    body = (
      <DocketReader title={view.title} text={view.text} onDone={() => setView(THREADS_VIEW)} />
    );
  } else if (threads.length === 0) {
    body = <TugEmptyLine data-slot="docket-empty">Nothing filed</TugEmptyLine>;
  } else {
    body = (
      <div
        className="docket-list"
        data-docket-list=""
        ref={attachPress}
        onContextMenu={onListContextMenu}
      >
        <TugListView<DocketThreadSource>
          ref={listRef}
          dataSource={source}
          delegate={delegate}
          cellRenderers={THREAD_CELL_RENDERERS}
          rowLayout="flush"
          commitOnEnter="act"
          className="docket-thread-list"
        />
      </div>
    );
  }

  return (
    <ResponderScope>
      <div
        data-slot="docket-card"
        className="docket-card"
        data-tug-scroll-key="docket-card"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <div className="docket-card-header" data-slot="docket-card-header">
          {showProjectChooser ? (
            <div className="docket-project-chooser">
              <TugPopupButton
                size="sm"
                label={projectName}
                items={projectItems}
                data-testid="docket-project-chooser"
              />
            </div>
          ) : null}
          <div ref={chooserRef} className="docket-chooser">
            <TugPopupButton
              size="sm"
              label={docket?.name ?? (dockets.length === 0 ? "No Dockets" : "Choose a Docket")}
              items={docketItems}
              disabled={effectiveProjectDir === null}
              data-testid="docket-chooser"
            />
          </div>
          {docket !== null && effectiveProjectDir !== null ? (
            <span className="docket-card-atom" data-slot="docket-card-atom">
              <TugAtomChip
                type="docket"
                label={docket.name}
                value={docket.id}
                docket={{ projectDir: effectiveProjectDir }}
                maxLabelWidth={220}
              />
            </span>
          ) : null}
        </div>
        <div className="docket-filing" data-slot="docket-filing">
          <TugMessageEditor
            ref={editorRef}
            maxRows={1}
            placeholder="Type an idea, or paste to file"
            borderless={false}
            extensions={fieldExtensions}
            onSubmit={fileField}
            disabled={docket === null}
            data-testid="docket-filing-field"
            aria-label="File on this docket"
          />
          {filingLine !== null && filingLine.length > 0 ? (
            <div className="docket-filing-line" data-slot="docket-filing-line" role="status">
              {filingLine}
            </div>
          ) : null}
        </div>
        <div className="docket-card-body">{body}</div>
        {renderMenu(menuItems)}
        <TugConfirmPopover
          open={confirmingRetire}
          anchorEl={chooserRef.current}
          message="Retire this docket? It leaves the chooser and returns under Show Retired."
          confirmLabel="Retire"
          side="bottom"
          align="start"
          onConfirm={() => {
            setConfirmingRetire(false);
            const d = liveRef.current.docket;
            if (d === null) return;
            send((verbs, dir) => verbs.retire({ projectDir: dir, id: d.id, retired: true }));
          }}
          onCancel={() => setConfirmingRetire(false)}
        />
        <TugConfirmPopover
          open={staleAsk !== null}
          anchorEl={staleAsk?.anchor ?? null}
          message={staleAsk?.message ?? ""}
          confirmLabel="Open"
          side="bottom"
          align="end"
          onConfirm={() => {
            const ask = staleAsk;
            setStaleAsk(null);
            if (ask !== null) openGesture(ask.gesture, ask.key);
          }}
          onCancel={() => setStaleAsk(null)}
        />
        {naming !== null ? (
          <DocketNameDialog
            placeholder={naming === "new" ? "Name the new docket" : "Rename the docket"}
            verb={naming === "new" ? "Create" : "Rename to"}
            onCommit={commitName}
            onDismiss={() => setNaming(null)}
          />
        ) : null}
      </div>
    </ResponderScope>
  );
}

/** What the card's body shows. */
type DocketView =
  | { kind: "threads" }
  | {
      kind: "edit-sketch";
      id: string;
      base: number;
      text: string;
      versions: readonly SketchVersionRow[];
    }
  | { kind: "read"; title: string; text: string };

const THREADS_VIEW: DocketView = { kind: "threads" };

const NO_THREADS: readonly DocketThread[] = [];

/** The name a docket card shows, from the target its registry entry holds. */
export function liveDocketName(cardId: string, snapshot: DocketsSnapshot): string | null {
  const target = getOpenDocketCard(cardId)?.getTarget() ?? null;
  if (target === null) return null;
  const project = snapshot.projects.find((p) => p.project_dir === target.projectDir);
  return project?.dockets.find((d) => d.id === target.docketId)?.name ?? null;
}
