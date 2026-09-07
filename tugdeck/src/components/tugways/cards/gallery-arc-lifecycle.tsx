/**
 * gallery-arc-lifecycle.tsx — the six components that carry an arc through
 * its whole life, demoed over wire-shaped fixtures.
 *
 * This card is the documented home of the arc lifecycle grammar:
 *
 *   - `TugArcAtom` — the one skin, two sizes. A direct arc is an arc to it.
 *   - `TugArcTrack` — brief · devise · review · implement (ticks) · join, in
 *     a cap-height strip of CONSTANT width, whose current cell breathes;
 *     `arcTrackModelFromEntry` derives it from the wire.
 *   - `ArcPhaseMark` — the same five phases as one glyph, keyed on the
 *     lifecycle phase rather than on the git stage.
 *   - `ArcLifecycleMark` — the COMPACT register: one pill · glyph · fraction.
 *     For the two surfaces where a session is the subject and the arc is one
 *     fact about it.
 *   - `ArcLifecycleLine` — track · glyph · <Doing> [i/N] · <in the way>. One
 *     clause saying what the arc is doing, then one saying what is in its
 *     way, and no age.
 *   - `ArcLifecycleBlock` — eyebrow (atom · rule · worker) over the line:
 *     the rail row, the shade row and the receipt's header, at one scale.
 *     The eyebrow says WHO, the line says WHAT — every reading of the arc's
 *     state, the phase glyph included, is on the second line.
 *
 * **Two shapes, one grammar.** The strip belongs to the three surfaces
 * whose subject IS the arc (the rail's Arcs section, the Changes shade, the
 * ARC placard); the two where a session is the subject get the mark instead.
 * The sixth, Z2's ARC cell, is an instrument readout and takes the shape its
 * four neighbours already take: two dots and a word. The rules are [D168].
 *
 * **Every moment below is ONE wire entry.** The track model, the reading, the
 * facts, and the masthead's binding are all projections of that single object,
 * so no two panels on a row can disagree.
 *
 * **Nothing here is drawn by hand, and the masthead least of all.** The
 * masthead frame mounts the real `SessionIdentityRow` at the real
 * `SessionMasthead`'s settings — one mark per row, the dense dot packed at the
 * column, the description ladder beneath — with the arc binding handed to it
 * rather than read from the store, which is the demo of the `arc` prop. Where
 * an earlier draft assembled a row out of parts, it produced two pulsing dots
 * in two states, which is a thing the app has never shown and would never
 * show. A frame that can differ from the app is a frame that can lie about it.
 *
 * **The last section is the blocked join, in three cases.** One `base-dirt`
 * bit used to hide them all behind one sentence naming acts no control here
 * performs. Each case now carries what its facts earn — the base copy the arc
 * already holds is not a refusal at all, the user's own divergent edit gets one
 * `Resolve`, another session's gets the same shape with a dead button wearing
 * whose turn it is — and every frame mounts the real `SessionChangesArcJoin`
 * over one wire entry, so what is drawn is what the shade draws. The remedy is
 * never in the button: the sentence carries it and the control is one word.
 */

import "./gallery-arc-lifecycle.css";

import React from "react";

import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import {
  ArcLifecycleLine,
} from "@/components/tugways/arc-lifecycle-line";
import {
  ArcLifecycleMark,
  arcMarkFraction,
} from "@/components/tugways/arc-lifecycle-mark";
import { ArcPhaseMark } from "@/components/tugways/arc-phase-mark";
import { ArcJoinRegister } from "@/components/tugways/arc-join-register";
import { SessionChangesArcJoin } from "@/components/tugways/cards/session-changes/session-changes-arc-join";
import { SessionChangesArcBrief } from "@/components/tugways/cards/session-changes/session-changes-arc-brief";

import { arcEntryGlanceFraction, arcMetaFacts } from "@/lib/arc-meta-facts";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";

import {
  TugArcTrack,
  arcCellWord,
  arcTrackModel,
  arcTrackModelFromEntry,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TugStatusCell } from "@/components/tugways/tug-status-cell";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";

import type {
  ArcChangesetEntry,
  ArcJoinBlockerWire,
  ArcStep,
} from "@/lib/changeset-types";
import type { ResolveState } from "@/lib/changeset-join-store";
import type { ArcSessionFact } from "@/lib/arc-session-index";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures — one wire entry per point in an arc's life, planned and direct
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/tugtool";
const WORKER = "5d2e9b10-0000-4000-8000-00000000d45c";
const SOLO = "5d2e9b10-0000-4000-8000-00000000b0ce";
const TOUCHED = 1_760_000_000_000;
const PLAN = `${ROOT}/.tug/arcs/tugedit-bringup/plan.md`;
const BRIEF = `${ROOT}/.tug/arcs/tugedit-bringup/brief.md`;

sessionNameStore.setName(WORKER, "tugedit bringup");
sessionTagStore.setTag(WORKER, "juicy-river-3");
sessionNameStore.setName(SOLO, "rail polish");
sessionTagStore.setTag(SOLO, "amber-fox-7");

function steps(
  done: number,
  current: number | null,
  total: number,
): ArcStep[] {
  return Array.from({ length: total }, (_, i) => ({
    title: `Step ${i + 1}`,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));
}

function entry(
  name: string,
  over: Partial<ArcChangesetEntry>,
): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: `tugarc/${name}#spike-${name}`,
    display_name: name,
    base: "main",
    rounds: 0,
    worktree: `${ROOT}/.tug/worktrees/${name}`,
    worktree_dirty: false,
    files: [],
    last_activity: new Date(TOUCHED).toISOString(),
    ...over,
  };
}

/** The arc branch's files, once there is a branch. */
const BRANCH_FILES = [
  {
    path: "tugrust/crates/tugedit-core/src/parse.rs",
    git_status: "A",
    op: "write",
    origin: "arc",
    shared: false,
    last_touched: TOUCHED,
  },
];

/** One point in an arc's life. */
interface Moment {
  key: string;
  caption: string;
  worker: string | null;
  entry: ArcChangesetEntry;
  /** What the masthead's description line carries — this card's last prompt. */
  prompt: string;
  /** False before `arc create` cuts the branch: the Today column has nothing. */
  branched: boolean;
}

const IMPLEMENT_TITLE = "`tugtool file edit`, the `tugedit` bin, and the receipt";
const DRAFT_SUBJECT = "Add tugedit-core and the edit-program language";
const ARC = "tugedit-bringup";
const SOLO_SUBJECT = "rail Arcs empty state reads None, centered";
const SOLO_ARC = "rail-none-empty";
const SOLO_PLAN = `${ROOT}/.tug/arcs/${SOLO_ARC}/plan.md`;

const MOMENTS: readonly Moment[] = [
  {
    key: "brief",
    caption: "The brief is written; the wheel has not turned yet",
    worker: WORKER,
    prompt: "/tugplug:arc tugedit — the edit-program language and its gate",
    branched: false,
    entry: entry(ARC, { documents: { brief: BRIEF } }),
  },
  {
    key: "devise",
    caption:
      "Devise is on the card — the point every surface but the rail shows nothing for today",
    worker: WORKER,
    prompt: "/tugplug:arc-devise tugedit-bringup",
    branched: false,
    entry: entry(ARC, {
      documents: { brief: BRIEF },
      arc: { stage: "devise" },
    }),
  },
  {
    key: "review",
    caption: "Review is on the card; the plan exists and has ten steps",
    worker: WORKER,
    prompt: "/tugplug:arc-review tugedit-bringup",
    branched: false,
    entry: entry(ARC, {
      documents: { brief: BRIEF, plan: PLAN },
      arc: { stage: "review" },
      steps: steps(0, null, 10),
      step_total: 10,
      review: "never-reviewed",
    }),
  },
  {
    key: "implement",
    caption:
      "Implement, step 4 of 10 — the one point the app draws on every surface today",
    worker: WORKER,
    prompt: "/tugplug:arc-implement tugedit-bringup",
    branched: true,
    entry: entry(ARC, {
      branch: `tugarc/${ARC}`,
      bound_session: WORKER,
      stage: "implementing",
      arc: { stage: "implement" },
      step_current: 4,
      step_total: 10,
      run_position: 4,
      run_length: 10,
      step_title: IMPLEMENT_TITLE,
      steps: steps(3, 4, 10),
      documents: { brief: BRIEF, plan: PLAN },
      review: "reviewed",
      rounds: 3,
      files: BRANCH_FILES,
      worktree_dirty: true,
      base_ahead: 1,
    }),
  },
  {
    key: "stopped",
    caption: "The arc stopped in implement — the stop outranks the track",
    worker: null,
    prompt: "/tugplug:arc-implement tugedit-bringup",
    branched: true,
    entry: entry(ARC, {
      branch: `tugarc/${ARC}`,
      stage: "working",
      arc: {
        stage: "implement",
        stopped: "card closed",
        stopped_stage: "implement",
      },
      step_current: 7,
      step_total: 10,
      run_position: 7,
      run_length: 10,
      step_title: "the receipt's proof-class rows",
      steps: steps(6, 7, 10),
      documents: { brief: BRIEF, plan: PLAN },
      review: "reviewed",
      rounds: 6,
      files: BRANCH_FILES,
    }),
  },
  {
    key: "ready",
    caption: "Every step done; the draft is written and the join is offered",
    worker: WORKER,
    prompt: "/tugplug:arc-implement tugedit-bringup",
    branched: true,
    entry: entry(ARC, {
      branch: `tugarc/${ARC}`,
      bound_session: WORKER,
      stage: "draft-ready",
      arc: { stage: "implement", done: true },
      step_current: 10,
      step_total: 10,
      run_position: 10,
      run_length: 10,
      steps: steps(10, null, 10),
      documents: { brief: BRIEF, plan: PLAN },
      review: "reviewed",
      rounds: 10,
      files: BRANCH_FILES,
      draft: {
        fingerprint: "spike",
        updated_at: TOUCHED,
        message: `${DRAFT_SUBJECT}\n\nBody.`,
      },
    }),
  },
  {
    key: "direct-listed",
    caption:
      "A DIRECT arc — no wheel driving it — the moment its task list is written and before any round lands. TWO cells, because devise and review were never skipped: a plain arc never has them, and a five-cell strip with two struck out would say otherwise. The fraction is real from the first frame: the task list is an ordinary plan document, so `0/3` is counted rather than stood in for",
    worker: SOLO,
    prompt: `/arc ${SOLO_ARC} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_ARC, {
      branch: `tugarc/${SOLO_ARC}`,
      bound_session: SOLO,
      stage: "working",
      steps: steps(0, null, 3),
      step_total: 3,
      documents: { plan: SOLO_PLAN },
      task_list: true,
      files: BRANCH_FILES,
    }),
  },
  {
    key: "direct-working",
    caption:
      "The same arc mid-walk, step 2 of 3. Its implement cell holds the same three-cell width a planned arc's does and its ticks divide it, so the two read as one instrument at two plan lengths — nothing about the strip says which session is driving. Who is on it is the atom beside it",
    worker: SOLO,
    prompt: `/arc ${SOLO_ARC} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_ARC, {
      branch: `tugarc/${SOLO_ARC}`,
      bound_session: SOLO,
      stage: "implementing",
      step_current: 2,
      step_total: 3,
      run_position: 2,
      run_length: 3,
      step_title: "Centre the empty reading in its own row",
      steps: steps(1, 2, 3),
      documents: { plan: SOLO_PLAN },
      task_list: true,
      rounds: 1,
      files: BRANCH_FILES,
      worktree_dirty: true,
    }),
  },
  {
    key: "direct-ready",
    caption:
      "Every task closed and the draft written — the join, offered on the same terms a planned arc's is. The join cell fills and the phase glyph turns over; nothing here distinguishes the two kinds, because at the join there is nothing left to distinguish",
    worker: SOLO,
    prompt: `/arc ${SOLO_ARC} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_ARC, {
      branch: `tugarc/${SOLO_ARC}`,
      bound_session: SOLO,
      stage: "draft-ready",
      step_current: 3,
      step_total: 3,
      run_position: 3,
      run_length: 3,
      steps: steps(3, null, 3),
      documents: { plan: SOLO_PLAN },
      task_list: true,
      rounds: 3,
      files: BRANCH_FILES,
      draft: {
        fingerprint: "spike",
        updated_at: TOUCHED,
        message: SOLO_SUBJECT,
      },
    }),
  },
  {
    key: "direct-listless",
    caption:
      "An arc with no documents at all — every plain arc cut before task lists existed, and any run that skipped writing one. The strip is the same three cells and the implement cell is bare, because there is nothing to divide it into. This is the one case that still reads a WORD where the others read numbers",
    worker: SOLO,
    prompt: `/arc ${SOLO_ARC} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_ARC, {
      branch: `tugarc/${SOLO_ARC}`,
      bound_session: SOLO,
      stage: "working",
      rounds: 2,
      files: BRANCH_FILES,
      worktree_dirty: true,
      draft: {
        fingerprint: "spike",
        updated_at: TOUCHED,
        message: SOLO_SUBJECT,
      },
    }),
  },
];

// ---------------------------------------------------------------------------
// A join the base refuses — one wire entry per case, as the server sends it
// ---------------------------------------------------------------------------

const BLOCKED_ARC = "durable-commits";
const BLOCKED_PATH = "tuglaws/design-decisions.md";
const OTHER = "5d2e9b10-0000-4000-8000-00000000a11c";
sessionNameStore.setName(OTHER, "ink anchor");
sessionTagStore.setTag(OTHER, "ink-anchor");

const RESOLVE_IDLE: ResolveState = { phase: "idle", progress: [], error: null };

/** One shape of blocked join, with the reading its facts earn. */
interface BlockedCase {
  key: string;
  title: string;
  caption: string;
  blocker: ArcJoinBlockerWire;
}

/**
 * The three cases one `base-dirt` bit used to hide.
 *
 * Every field below is what `join_blockers_from_detail` composes — the
 * sentence, the paths, each path's relation and holder, and the one remedy.
 * The deck writes none of it: a second copy here would be free to disagree
 * with the act the server performs.
 */
const BLOCKED_CASES: readonly BlockedCase[] = [
  {
    key: "identical",
    title:
      "A · the base holds the arc's own edit — no longer a blocker at all",
    caption:
      "Main's uncommitted copy is byte for byte what the arc already wrote — the server can say so because it compared blob ids rather than assuming from the fact of the dirt. Nothing is lost by dropping it, so there is no blocker and no button: the join drops the copy, lands, and reports what it dropped. The clear is still required, because git compares the working tree against HEAD rather than against the merge result",
    blocker: {
      kind: "base-dirt",
      title: "Base work in the way",
      detail: "",
    },
  },
  {
    key: "divergent-mine",
    title: "B · your own live work on main",
    caption:
      "This session edited the file on main while the arc ran, and the two versions differ. Resolve commits that edit onto the base as one commit of its own — from there the two sides are ordinary git history, so the collision reaches the same resolution ladder every join conflict already reaches. No new merge machinery, and Undo beside the receipt puts the work back uncommitted",
    blocker: {
      kind: "base-dirt",
      title: "Base work in the way",
      detail: `Cannot join: your uncommitted edit to ${BLOCKED_PATH} on the base differs from this arc's version of it.`,
      paths: [BLOCKED_PATH],
      remedy: {
        explain:
          "Resolve commits this 1 file — yours — onto main as one commit, “Commit base work in progress to unblock the join of durable-commits”. Nothing changes on disk, and Undo here puts them back uncommitted.",
      },
    },
  },
  {
    key: "divergent-foreign",
    title: "C · another live session's work",
    caption:
      "The changeset feed's attribution — the same fold the Changes card renders, passed down rather than re-derived — says another live session holds this path. The button is as live as case B's, because committing work preserves it: the fold takes the holder's edit onto the base as its own attributed commit, their files do not change on disk, and their session gets a quiet notice saying what happened and how to undo it",
    blocker: {
      kind: "base-dirt",
      title: "Another session's edit",
      detail: `Cannot join: ^ink-anchor holds an uncommitted edit to ${BLOCKED_PATH} that this arc also changed.`,
      paths: [BLOCKED_PATH],
      remedy: {
        explain:
          "Resolve commits this 1 file — ^ink-anchor's work in progress — onto main as one commit, “Commit base work in progress to unblock the join of durable-commits”. Nothing changes on disk, their session is told, and Undo here puts them back uncommitted.",
      },
    },
  },
];

// ---------------------------------------------------------------------------
// The brief — what a finished arc would land, as a briefing
// ---------------------------------------------------------------------------

const BRIEF_ARC = "entity-menus";

/** A real-sized change: twenty-one files across six areas, counted. */
const BRIEF_FILES = (
  [
    ["tugdeck/src/components/tugways/annotation-menu.tsx", "A", 212, 0],
    ["tugdeck/src/components/tugways/annotation-menu.css", "A", 48, 0],
    ["tugdeck/src/components/tugways/tug-transcript-cell.tsx", "M", 31, 118],
    ["tugdeck/src/components/tugways/tug-prompt-entry.tsx", "M", 22, 64],
    ["tugdeck/src/components/tugways/tug-history-list.tsx", "M", 14, 41],
    ["tugdeck/src/components/tugways/tug-changes-list.tsx", "M", 12, 37],
    ["tugdeck/src/components/tugways/session-identity-row.tsx", "M", 9, 22],
    ["tugdeck/src/components/tugways/commit-row-menu.tsx", "D", 0, 96],
    ["tugdeck/src/components/tugways/session-identity-menu.tsx", "D", 0, 84],
    ["tugdeck/src/lib/annotation-registry.ts", "M", 88, 12],
    ["tugdeck/src/lib/annotation-menu-facts.ts", "A", 61, 0],
    ["tugdeck/src/lib/__tests__/annotation-registry.test.ts", "M", 74, 6],
    ["tugrust/crates/tugarc-core/src/ops.rs", "M", 40, 9],
    ["tugrust/crates/tugcast-core/src/types.rs", "M", 6, 0],
    ["tugrust/crates/tugcast/src/feeds/changeset.rs", "M", 18, 3],
    ["tests/app-test/at0387-session-identity-menu.test.ts", "M", 33, 21],
    ["tests/app-test/at0432-commit-row-menu.test.ts", "M", 29, 17],
    ["tests/app-test/at0499-annotation-menu.test.ts", "A", 140, 0],
    ["tests/app-test/at0405-changes-arc-lane.test.ts", "M", 4, 4],
    ["tuglaws/entity-presentation.md", "M", 11, 3],
    ["tugplug/skills/draft/SKILL.md", "M", 5, 1],
  ] as const
).map(([path, git_status, added, deleted]) => ({
  path,
  git_status,
  op: git_status === "A" ? "write" : git_status === "D" ? "deleted" : "edit",
  origin: "arc",
  shared: false,
  last_touched: TOUCHED,
  added,
  deleted,
}));

const BRIEF_SUBJECT = "Answer one right-click menu per entity, from the annotation registry";

/** The message as the skills now write it: subject, a summary paragraph, then the detail. */
const BRIEF_MESSAGE = `tugarc(${BRIEF_ARC}): ${BRIEF_SUBJECT}

The annotation registry claimed to own what a right-click on an entity offers, and did not: the path was private to the transcript cell, so every other surface wrote its own menu and the same entity said different things depending on where it was clicked. useAnnotationMenu is that path, lifted whole and mountable anywhere, with the entity's actions shared and the surface's own selection actions kept apart.

- useAnnotationMenu: one delegated listener and one context-menu provider for nine entity kinds, mounted by the transcript, the composer, the History list, the Changes shade and the identity row
- menuEntries takes an AnnotationMenuFacts record beside the payload, discriminated by kind, so a surface holding an id alone is never offered an act it cannot perform ([L31])
- commit-row-menu and session-identity-menu deleted; their items live in the registry's list, in the registry's order
- at0499 drives the shared menu on every surface; at0387 and at0432 assert the same items from the new path`;

/** The same message without its summary — how an older draft reads. */
const BRIEF_MESSAGE_UNSUMMARIZED = `tugarc(${BRIEF_ARC}): ${BRIEF_SUBJECT}

${BRIEF_MESSAGE.split("\n").slice(4).join("\n")}`;

const BRIEF_ROUNDS = [
  "tugarc(entity-menus): Drive the shared menu on every surface",
  "tugarc(entity-menus): Delete the two private menus",
  "tugarc(entity-menus): Discriminate menu facts by kind",
  "tugarc(entity-menus): Lift useAnnotationMenu out of the cell",
];

function briefEntry(message: string, source: string): ArcChangesetEntry {
  return entry(BRIEF_ARC, {
    branch: `tugarc/${BRIEF_ARC}`,
    bound_session: SOLO,
    stage: "ready",
    steps: steps(4, null, 4),
    step_total: 4,
    documents: { plan: `${ROOT}/.tug/arcs/${BRIEF_ARC}/plan.md` },
    task_list: true,
    rounds: BRIEF_ROUNDS.length,
    round_subjects: BRIEF_ROUNDS,
    files: BRIEF_FILES,
    fit: { current: true, head: "05c9f2ebb0000", base: "fbe9ca5b00000" },
    join: {
      phase: "previewed",
      offer: {
        request_id: `${BRIEF_ARC}:fbe9ca5b:05c9f2eb`,
        base_sha: "fbe9ca5b00000",
        arc_head: "05c9f2ebb0000",
        message,
        message_source: source,
      },
    },
  });
}

/** A ready arc the preflight refused: every step done, the draft written. */
function blockedEntry(blocker: ArcJoinBlockerWire): ArcChangesetEntry {
  const blockers = blocker.detail === "" ? [] : [blocker];
  return entry(BLOCKED_ARC, {
    branch: `tugarc/${BLOCKED_ARC}`,
    bound_session: SOLO,
    stage: "ready",
    steps: steps(6, null, 6),
    step_total: 6,
    documents: { plan: `${ROOT}/.tug/arcs/${BLOCKED_ARC}/plan.md` },
    task_list: true,
    rounds: 6,
    files: [
      {
        path: BLOCKED_PATH,
        git_status: "M",
        op: "write",
        origin: "arc",
        shared: false,
        last_touched: TOUCHED,
      },
    ],
    base_overlap: [BLOCKED_PATH],
    last_replay: "replayed",
    draft: {
      fingerprint: "spike",
      updated_at: TOUCHED,
      message: "Doctrine and integration checks for durable commits",
    },
    join: {
      phase: blockers.length > 0 ? "blocked" : "previewed",
      ...(blockers.length > 0 ? { blockers } : {}),
    },
  });
}

/**
 * The session-scoped binding, projected from the entry exactly as
 * `arcSessionIndex` projects it — so the masthead is reading the same object
 * the two blocks beside it are.
 */
function factFor(m: Moment): ArcSessionFact {
  const e = m.entry;
  return {
    ownerId: e.owner_id,
    name: e.display_name,
    stage: e.stage ?? null,
    arc: e.arc ?? null,
    review: e.review ?? null,
    projectDir: ROOT,
    stepCurrent: e.step_current ?? null,
    stepTotal: e.step_total ?? null,
    runPosition: e.run_position ?? null,
    runLength: e.run_length ?? null,
    stepTitle: e.step_title ?? null,
    hasPlan: e.documents?.plan !== undefined,
    entry: e,
  };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function Stage({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="cg-arc-stage">
      <TugLabel size="2xs" emphasis="calm" className="cg-arc-caption">
        {caption}
      </TugLabel>
      {children}
    </section>
  );
}

function Worker({ sessionId }: { sessionId: string }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return (
    <TugSessionIdentity
      identity={identity}
      tier="chip"
      arc={false}
      tooltip={false}
    />
  );
}

const AT_WORK = MOMENTS[3]!;

/**
 * A plan of `total` steps, `current` in progress — the fixture for the one
 * claim a single moment cannot make: that the strip is the same width at three
 * steps and at twenty-four.
 */
function planOf(total: number, current: number): ArcTrackModel {
  return arcTrackModel({
    documents: { brief: BRIEF, plan: PLAN },
    arc: { stage: "implement" },
    stage: "implementing",
    steps: steps(current - 1, current, total),
  });
}

/**
 * A plan whose fifth step was closed before its fourth — the fixture for the
 * claim that the tick in hand outranks the closed reading. Built from the
 * ledger's own statuses rather than from `steps()`, which only knows prefixes.
 */
const OUT_OF_ORDER: ArcTrackModel = arcTrackModel({
  documents: { brief: BRIEF, plan: PLAN },
  arc: { stage: "implement" },
  stage: "implementing",
  steps: (
    ["done", "done", "done", "in progress", "done", "pending"] as const
  ).map((status, i) => ({
    title: `Step ${i + 1}`,
    status,
  })),
});

const NO_JOIN_ACTIONS = {
  aim: () => {},
  answerQuestion: () => {},
  resolveBase: () => {},
  undoResolveBase: () => {},
};

export function GalleryArcLifecycle(): React.ReactElement {
  return (
    <div className="cg-content" data-testid="gallery-arc-lifecycle">
      <section className="cg-section">
        <TugLabel className="cg-section-title">
          The atom, once — TugArcAtom
        </TugLabel>
        <Stage caption="One skin, one register, proportional everywhere; who is on it is the atom beside it. A direct arc is an arc to the atom: both are work on a worktree">
          <div className="cg-arc-lineup">
            <TugArcAtom name={ARC} />
            <span className="cg-arc-pair">
              <Worker sessionId={WORKER} />
              <TugArcAtom name={ARC} />
            </span>
            <TugArcAtom name="rail-none-empty" />
          </div>
        </Stage>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">
          The lifecycle, as one track — TugArcTrack
        </TugLabel>
        <Stage caption="brief · devise · review · implement (one tick per step) · join. Each row is the real ArcLifecycleLine, so the strip, the glyph, the fraction, and the word are spaced by the component rather than by this card. A direct arc draws brief · implement · join: it never had the two middle cells, but it did have a brief, so both round ends land on whole cells instead of the endcap travelling onto the first tick. The track is centred in its row and the reading — glyph, fraction, word, facts — is flush right, which is the eyebrow's own two-edge anchoring one line down. Cap-height, so it rides any line the atom is on. The type runs sit on one baseline and the two graphics are centred, which lands the cap-height strip on the type's own cap band; the glyph is sized a pixel proud of that band rather than four, so it reads as the strip's neighbour. What is behind you is a FILL and what is ahead is an OUTLINE: done is the muted text tone, active the theme's key color — the tone the pulsing dot uses for the same claim — the join the theme's selection color, and pending no fill at all">
          <div className="cg-arc-legend">
            {MOMENTS.map((m) => {
              const model = arcTrackModelFromEntry(m.entry);
              return (
                <ArcLifecycleLine
                  key={m.key}
                  model={model}
                />
              );
            })}
          </div>
        </Stage>
        <Stage caption="CONSTANT WIDTH. The implement cell is three cells wide at every plan length and its ticks divide it — three steps, eight, twenty-four, and the strip is the same graphic. A cell that sized to its ticks made the strip's width a function of the plan's length, so it grew under the reader and, on a narrow row, grew into whatever was set beside it">
          <div className="cg-arc-legend">
            {[3, 8, 24].map((n) => (
              <div className="cg-arc-legend-row" key={n}>
                <TugArcTrack model={planOf(n, Math.ceil(n / 3))} />
                <span className="cg-arc-legend-word">{`${n}-step plan`}</span>
              </div>
            ))}
          </div>
        </Stage>
        <Stage caption="The division of labour. An arc counts its steps in the track and nowhere else; the cell it is IN breathes, on the pulsing dot's own 2s envelope — quick in, slow out — so a strip and a dot on one row read as one instrument. A stopped arc holds still">
          <div className="cg-arc-legend-row">
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              state="running"
              aria-hidden
            />
            <TugArcTrack model={arcTrackModelFromEntry(AT_WORK.entry)} />
            <span className="cg-arc-legend-word">
              on an arc — the bare phase dot, and the track
            </span>
          </div>
        </Stage>
        <Stage caption="OUT OF ORDER. Steps 1–3 done, 4 in hand, 5 closed early. Four steps are done, so a strip that painted `n <= done` would fill tick 4 while it is the live one — which is the one reading this instrument must never give. The ticks are positional: done is a set of positions, and the step in hand outranks the closed reading. The ledger now refuses the way this used to happen — a `done` on a step nobody started — so a batched round that closes two steps at its end opens and closes each in turn">
          <div className="cg-arc-legend-row">
            <TugArcTrack model={OUT_OF_ORDER} />
            <span className="cg-arc-legend-word">
              4/6 — the fourth tick breathes, the fifth is filled
            </span>
          </div>
        </Stage>
        <Stage caption="The same five phases as one glyph — ArcPhaseMark. Keyed on the lifecycle PHASE, never on the git stage: an arc devising or reviewing a plan has no stage at all, which is how the mark that used to do this job came to be blank for the whole first half of an arc's life">
          <div className="cg-arc-legend-row">
            {MOMENTS.map((m) => (
              <ArcPhaseMark
                key={m.key}
                model={arcTrackModelFromEntry(m.entry)}
                size={16}
              />
            ))}
            <span className="cg-arc-legend-word">
              brief · devise · review · implement · stopped · join · then the
              four direct readings
            </span>
          </div>
        </Stage>
        <p className="cg-arc-prose">
          The row's indicator is a bare phase dot for the whole of an arc. A
          second mark drawing the same step count in another geometry would be
          free to disagree whenever one of them lagged, so the track has the
          subject alone. A stop is the one fact that outranks it: the cell
          paints danger, it stops breathing, and the line reads
          <code>Stopped · &lt;why&gt;</code>, in the log's own words.
        </p>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">
          The compact register — ArcLifecycleMark
        </TugLabel>
        <Stage caption="one pill · glyph · fraction — the full register's own order, one scale down. That the arc is alive, where it is, and how far along, in a box that cannot grow. The pill leads because it is the mark that touches the identity run it follows. The arc's NAME is not here: both hosts render the identity's own ^<arc> immediately to its left, and a second spelling of a name already on the line is a second thing to keep in step">
          <div className="cg-arc-legend">
            {MOMENTS.map((m) => (
              <div className="cg-arc-legend-row" key={m.key}>
                <ArcLifecycleMark
                  model={arcTrackModelFromEntry(m.entry)}
                  size="read"
                  name={m.entry.display_name}
                />
                <span className="cg-arc-legend-word">{m.caption}</span>
              </div>
            ))}
          </div>
        </Stage>
        <p className="cg-arc-prose">
          Two surfaces take this rather than the track, and they are the two
          where a SESSION is the subject and the arc is one fact about it: the
          session card's masthead title line, and the rail's session rows. Both
          lead with a name that elides, and the strip beside an eliding name is
          a graphic competing with the thing the row is named for. The pill
          wears the track's own palette and breathes on the track's own cycle,
          so the mark and the block read as one grammar.
        </p>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">
          Z2 · the ARC cell — an instrument, not a graphic
        </TugLabel>
        <Stage caption="STATE's shape, exactly: a dot pinned to each edge of the value wrap and the reading centered between them. NUMBERS whenever there are numbers — the declared run, else the plan's own pair, so a reviewed plan reads 0/10 rather than a word. The word is only for an arc with no plan at all. The cell takes STATE's 18ch because it wears STATE's construction, and JOBS gives back exactly that, so the row's total is the same 80ch either way and every container rung keeps its measured value">
          {/* The real row class, so the cells sit in the row's own 10px font
              and endcap apparatus, and the real `data-arc` flag, so the
              widths under test are the ones the app applies. */}
          <div
            className="session-telemetry-status-row cg-arc-z2-row"
            data-arc="true"
          >
            {MOMENTS.map((m) => {
              const model = arcTrackModelFromEntry(m.entry);
              const pair =
                arcEntryGlanceFraction(m.entry) ?? arcMarkFraction(model);
              const reading =
                pair !== null
                  ? `${pair.current}/${pair.total}`
                  : arcCellWord(model);
              const state = model.stopped !== null ? "aborted" : "running";
              return (
                <TugStatusCell key={m.key} priority="tasks" label="ARC">
                  <TugProgressIndicator
                    variant="pulsing-dot"
                    size={12}
                    state={state}
                    aria-hidden
                  />
                  <span
                    className="session-telemetry-status-value"
                    data-slot="session-telemetry-arc-value"
                    aria-label={`arc ${m.entry.display_name}`}
                  >
                    {reading}
                  </span>
                  <TugProgressIndicator
                    variant="pulsing-dot"
                    size={12}
                    state={state}
                    aria-hidden
                  />
                </TugStatusCell>
              );
            })}
          </div>
        </Stage>
        <p className="cg-arc-prose">
          The whole track lived in this cell for a while, retuned by four knob
          overrides to survive a 78px box, and it drew ticks a pixel wide — a
          graphic too small to read at the size it was drawn. The cell now says
          the one thing that changes while somebody watches, and the strip is
          one press away on this cell's own placard.
        </p>
      </section>
      <section className="cg-section">
        <TugLabel className="cg-section-title">
          In flight — on every surface, no surface taller
        </TugLabel>
        {MOMENTS.map((m) => {
          const model = arcTrackModelFromEntry(m.entry);
          const stepTitle = m.entry.step_title ?? null;
          const facts = arcMetaFacts(m.entry);
          const name = m.entry.display_name;
          return (
            <Stage key={m.key} caption={m.caption}>
              <div className="cg-arc-surfaces">
                <div className="cg-arc-surface">
                  <span className="cg-arc-surface-name">
                    Arcs card / Changes shade · ArcLifecycleBlock
                  </span>
                  <ArcLifecycleBlock
                    name={name}
                    worker={m.worker}
                    model={model}
                    stepTitle={stepTitle}
                    facts={facts}
                  />
                </div>
                <div className="cg-arc-surface" data-wide="true">
                  <span className="cg-arc-surface-name">
                    Masthead · the real SessionIdentityRow, at SessionMasthead's
                    settings
                  </span>
                  <SessionIdentityRow
                    className="cg-arc-masthead-row"
                    sessionId={m.worker ?? WORKER}
                    projectDir={ROOT}
                    arc={factFor(m)}
                    dotSize={TUG_SESSION_ROW_STACK_DOT_SIZE}
                    indicatorPacking="column"
                    subAlign="title"
                    activityOverride={m.prompt}
                  />
                </div>
              </div>
            </Stage>
          );
        })}
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">
          The brief — what a finished arc would land, as a briefing
        </TugLabel>
        <Stage caption="The fold used to end in three artifacts printed whole: the landing message in monospace at its full length, every changed path in snapshot order, every round's subject. Each was complete and none was a summary. The brief fronts what aggregates — the subject in prose, a strip of counts, the message's own summary paragraph, the tree's areas by churn — and every list stands one fold away, mounted and closed. A cluster of one file is that file. This is the real SessionChangesArcBrief over one wire entry: twenty-one files, six areas, four rounds">
          <div className="cg-arc-surfaces">
            <div className="cg-arc-surface">
              <span className="cg-arc-surface-name">
                Summarized — the draft as the skills now write it
              </span>
              <SessionChangesArcBrief
                entry={briefEntry(BRIEF_MESSAGE, "draft")}
                projectRoot={ROOT}
                branch={`tugarc/${BRIEF_ARC}`}
              />
            </div>
            <div className="cg-arc-surface">
              <span className="cg-arc-surface-name">
                Unsummarized — an older draft, clamped at a screenful
              </span>
              <SessionChangesArcBrief
                entry={briefEntry(BRIEF_MESSAGE_UNSUMMARIZED, "draft")}
                projectRoot={ROOT}
                branch={`tugarc/${BRIEF_ARC}`}
              />
            </div>
          </div>
        </Stage>
        <p className="cg-arc-prose">
          <strong>The message is not shortened; the presentation is.</strong>{" "}
          The wire carries one string, exactly what the join lands, and the
          subject and summary above are a reading of its shape — the first
          line, then the first paragraph that is prose rather than bullets.
          The skills write that paragraph once, when the whole session is in
          context, so nothing summarizes at the join moment and nothing is
          composed here. The areas are a pure fold of the path list: the
          deepest directory that gathers more than one changed file, so a lone
          file two levels under a busy directory joins it, and the root is
          never climbed to. The line counts ride the same wire row the path
          does, from one <code>--numstat</code> read of the same range.
        </p>
      </section>
      <section className="cg-section">
        <TugLabel className="cg-section-title">
          Blocked — what the base refuses, and the one way out
        </TugLabel>
        <Stage caption="A join blocked by base-side work used to end at a sentence naming two acts — commit, or stash — that no control here performs, and one `base-dirt` bit hid three situations. The overlap now says what the base's uncommitted bytes ARE and whose they are, and each case gets the reading its facts earn. The row states what is wrong once, in the register; the report under it says what Resolve will do, and carries the control that does it. Every frame mounts the real register and report over one wire entry, so what is drawn is what the shade draws">
          <div className="cg-arc-situations">
            {BLOCKED_CASES.map((c) => {
              const blockedEntryForCase = blockedEntry(c.blocker);
              return (
                <div className="cg-arc-surface" key={c.key}>
                  <span className="cg-arc-surface-name">{c.title}</span>
                  <TugLabel
                    size="2xs"
                    emphasis="calm"
                    className="cg-arc-caption"
                  >
                    {c.caption}
                  </TugLabel>
                  <span className="session-changes-arc-register">
                    <ArcJoinRegister
                      arc={BLOCKED_ARC}
                      base="main"
                      stage={blockedEntryForCase.stage}
                      join={blockedEntryForCase.join}
                      bound
                      altitude="entry"
                    />
                  </span>
                  <SessionChangesArcJoin
                    entry={blockedEntryForCase}
                    join={blockedEntryForCase.join ?? null}
                    error={null}
                    resolve={RESOLVE_IDLE}
                    actions={NO_JOIN_ACTIONS}
                  />
                </div>
              );
            })}
          </div>
        </Stage>
        <Stage caption="The row's whole reading, at both scales, for the case that still refuses. The register takes `blockers[0].detail` as its line — the server's own sentence, never a second copy composed here — and the fact chip counts the overlap beside it">
          <div className="cg-arc-surfaces">
            <div className="cg-arc-surface">
              <span className="cg-arc-surface-name">
                Arcs card / Changes shade · ArcLifecycleBlock
              </span>
              <ArcLifecycleBlock
                name={BLOCKED_ARC}
                worker={SOLO}
                model={arcTrackModelFromEntry(
                  blockedEntry(BLOCKED_CASES[1]!.blocker),
                )}
                facts={arcMetaFacts(blockedEntry(BLOCKED_CASES[1]!.blocker))}
              />
            </div>
          </div>
        </Stage>
        <p className="cg-arc-prose">
          <strong>The remedy is never in the button.</strong> The sentence
          carries it, so the reader weighs the act before pressing, and the
          control is always the same word — and it is always pressable ([L31]):
          a blocker either carries an act or carries no remedy at all. The
          kinds nothing at the card can clear, an off-base checkout or a
          teardown left by a crash, still render their sentence, so a refusal
          this deck has never heard of is shown rather than swallowed.
        </p>
        <p className="cg-arc-prose">
          Resolve is one act, and it{" "}
          <strong>clears the block and stops</strong> — landing stays the
          composer's send, which is why the button does not read "Resolve and
          join". Behind it: identical copies dropped, the user's own divergent
          edits committed onto the base as one commit whose message says what it
          is, and a path another live session holds folded with the rest —
          committing work preserves it — with the holder named in the commit's
          message and told by a quiet notice in their own transcript. It is
          op-logged as its own verb, so the <strong>Undo</strong> beside the
          receipt it leaves resets the base and leaves the same content
          uncommitted — and only ever that, since the press is refused by name
          once the arc's newest operation is anything but a fold. When the
          block clears, the
          card's quiet-moment reveal raises the shade on the now-ready arc —
          the reveal memory is keyed on the arc head, and a resolve moves the
          base, so the blocked-to-ready edge is what forgets the spent head.
        </p>
      </section>
    </div>
  );
}
