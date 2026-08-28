/**
 * gallery-dash-lifecycle.tsx — the six components that carry a dash through
 * its whole life, demoed over wire-shaped fixtures.
 *
 * This card is the documented home of the dash lifecycle grammar:
 *
 *   - `TugDashAtom` — the one skin, two sizes. A direct dash is a dash to it.
 *   - `TugDashTrack` — brief · devise · review · implement (ticks) · join, in
 *     a cap-height strip of CONSTANT width, whose current cell breathes;
 *     `dashTrackModelFromEntry` derives it from the wire.
 *   - `DashPhaseMark` — the same five phases as one glyph, keyed on the
 *     lifecycle phase rather than on the git stage.
 *   - `DashLifecycleMark` — the COMPACT register: one pill · glyph · fraction.
 *     For the two surfaces where a session is the subject and the dash is one
 *     fact about it.
 *   - `DashLifecycleLine` — track · glyph · fraction · note · facts. No age.
 *   - `DashLifecycleBlock` — eyebrow (atom · rule · workers) over the line:
 *     the Lens row and the shade row, at the rail and reading scales. The
 *     eyebrow says WHO, the line says WHAT — every reading of the dash's
 *     state, the phase glyph included, is on the second line.
 *
 * **Two registers, one grammar.** The strip belongs to the three surfaces
 * whose subject IS the dash (the Lens's Dashes section, the Changes shade, the
 * DASH placard); the two where a session is the subject get the mark instead.
 * The sixth, Z2's DASH cell, is an instrument readout and takes the shape its
 * four neighbours already take: two dots and a word. The rules are [D168].
 *
 * **Every moment below is ONE wire entry.** The track model, the note, the
 * facts, and the masthead's binding are all projections of that single object,
 * so no two panels on a row can disagree.
 *
 * **Nothing here is drawn by hand, and the masthead least of all.** The
 * masthead frame mounts the real `SessionIdentityRow` at the real
 * `SessionMasthead`'s settings — one mark per row, the dense dot packed at the
 * column, the description ladder beneath — with the dash binding handed to it
 * rather than read from the store, which is the demo of the `dash` prop. Where
 * an earlier draft assembled a row out of parts, it produced two pulsing dots
 * in two states, which is a thing the app has never shown and would never
 * show. A frame that can differ from the app is a frame that can lie about it.
 *
 * **The last section is a proposal, and says so.** A join the base refuses
 * today reaches the reader as a sentence — the server's `JoinBlocker.detail`,
 * rendered by the real `DashJoinRegister` and the real `SessionChangesDashJoin`
 * — and the sentence names acts no control on the surface can perform. The
 * frames after the shipping ones show the same refusal in three lines — what
 * is wrong, what Resolve will do, Resolve — off a wire shape the server does
 * not send yet. The proposed button walks the frame's register through the
 * beats it would run, because a gallery button that did nothing would be the
 * defect the proposal exists to remove ([L31]).
 */

import "./gallery-dash-lifecycle.css";

import React from "react";

import { DashLifecycleBlock } from "@/components/tugways/dash-lifecycle-block";
import { DashLifecycleLine, dashLifecycleNote } from "@/components/tugways/dash-lifecycle-line";
import { DashLifecycleMark, dashMarkFraction } from "@/components/tugways/dash-lifecycle-mark";
import { DashPhaseMark } from "@/components/tugways/dash-phase-mark";
import { DashJoinRegister } from "@/components/tugways/dash-join-register";
import { SessionChangesDashJoin } from "@/components/tugways/cards/session-changes/session-changes-dash-join";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";

import { dashEntryGlanceFraction, dashMetaFacts } from "@/lib/dash-meta-facts";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TugDashAtom } from "@/components/tugways/tug-dash-atom";

import {
  TugDashTrack,
  DASH_PHASE_LABELS,
  dashTrackModel,
  dashTrackModelFromEntry,
  type DashTrackModel,
} from "@/components/tugways/tug-dash-track";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TugStatusCell } from "@/components/tugways/tug-status-cell";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";

import type {
  DashChangesetEntry,
  DashJoinBlockerWire,
  DashStep,
} from "@/lib/changeset-types";
import type { ResolveState } from "@/lib/changeset-join-store";
import type { DashSessionFact } from "@/lib/dash-session-index";
import { useSessionIdentity } from "@/lib/session-identity";
import type { AtomRegister } from "@/lib/atom-register";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures — one wire entry per point in a dash's life, planned and direct
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/tugtool";
const WORKER = "5d2e9b10-0000-4000-8000-00000000d45c";
const SOLO = "5d2e9b10-0000-4000-8000-00000000b0ce";
const TOUCHED = 1_760_000_000_000;
const PLAN = `${ROOT}/.tug/dashes/tugrev-bringup/plan.md`;
const BRIEF = `${ROOT}/.tug/dashes/tugrev-bringup/brief.md`;

sessionNameStore.setName(WORKER, "tugrev bringup");
sessionTagStore.setTag(WORKER, "juicy-river-3");
sessionNameStore.setName(SOLO, "Lens polish");
sessionTagStore.setTag(SOLO, "amber-fox-7");

function steps(done: number, current: number | null, total: number): DashStep[] {
  return Array.from({ length: total }, (_, i) => ({
    title: `Step ${i + 1}`,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));
}

function entry(name: string, over: Partial<DashChangesetEntry>): DashChangesetEntry {
  return {
    kind: "dash",
    owner_id: `tugdash/${name}#spike-${name}`,
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

/** The dash branch's files, once there is a branch. */
const BRANCH_FILES = [
  {
    path: "tugrust/crates/tugrev-core/src/parse.rs",
    git_status: "A",
    op: "write",
    origin: "dash",
    shared: false,
    last_touched: TOUCHED,
  },
];

/** One point in a dash's life. */
interface Moment {
  key: string;
  caption: string;
  workers: readonly string[];
  entry: DashChangesetEntry;
  /** What the masthead's description line carries — this card's last prompt. */
  prompt: string;
  /** False before `dash create` cuts the branch: the Today column has nothing. */
  branched: boolean;
}

const IMPLEMENT_TITLE = "`tugutil file rev`, the `tugrev` bin, and the receipt";
const DRAFT_SUBJECT = "Add tugrev-core and the `.rev` edit language";
const DASH = "tugrev-bringup";
const SOLO_SUBJECT = "Lens Dashes empty state reads None, centered";
const SOLO_DASH = "lens-none-empty";
const SOLO_PLAN = `${ROOT}/.tug/dashes/${SOLO_DASH}/plan.md`;

const MOMENTS: readonly Moment[] = [
  {
    key: "brief",
    caption: "The brief is written; the wheel has not turned yet",
    workers: [WORKER],
    prompt: "/tugplug:dash tugrev — the `.rev` edit language and its gate",
    branched: false,
    entry: entry(DASH, { documents: { brief: BRIEF } }),
  },
  {
    key: "devise",
    caption: "Devise is on the card — the point every surface but the Lens shows nothing for today",
    workers: [WORKER],
    prompt: "/tugplug:dash-devise tugrev-bringup",
    branched: false,
    entry: entry(DASH, { documents: { brief: BRIEF }, arc: { stage: "devise" } }),
  },
  {
    key: "review",
    caption: "Review is on the card; the plan exists and has ten steps",
    workers: [WORKER],
    prompt: "/tugplug:dash-review tugrev-bringup",
    branched: false,
    entry: entry(DASH, {
      documents: { brief: BRIEF, plan: PLAN },
      arc: { stage: "review" },
      steps: steps(0, null, 10),
      step_total: 10,
      review: "never-reviewed",
    }),
  },
  {
    key: "implement",
    caption: "Implement, step 4 of 10 — the one point the app draws on every surface today",
    workers: [WORKER],
    prompt: "/tugplug:dash-implement tugrev-bringup",
    branched: true,
    entry: entry(DASH, {
      branch: `tugdash/${DASH}`,
      bound_sessions: [WORKER],
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
    workers: [],
    prompt: "/tugplug:dash-implement tugrev-bringup",
    branched: true,
    entry: entry(DASH, {
      branch: `tugdash/${DASH}`,
      stage: "working",
      arc: { stage: "implement", stopped: "card closed", stopped_stage: "implement" },
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
    workers: [WORKER],
    prompt: "/tugplug:dash-implement tugrev-bringup",
    branched: true,
    entry: entry(DASH, {
      branch: `tugdash/${DASH}`,
      bound_sessions: [WORKER],
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
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: `${DRAFT_SUBJECT}\n\nBody.` },
    }),
  },
  {
    key: "direct-listed",
    caption:
      "A DIRECT dash — no arc driving it — the moment its task list is written and before any round lands. TWO cells, because devise and review were never skipped: this dash never had them, and a five-cell strip with two struck out would say otherwise. The fraction is real from the first frame: the task list is an ordinary plan document, so `0/3` is counted rather than stood in for",
    workers: [SOLO],
    prompt: `/dash ${SOLO_DASH} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_DASH, {
      branch: `tugdash/${SOLO_DASH}`,
      bound_sessions: [SOLO],
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
      "The same dash mid-walk, step 2 of 3. Its implement cell holds the same three-cell width the arc's does and its ticks divide it, so the two read as one instrument at two plan lengths — nothing about the strip says which session is driving. Who is on it is the atom beside it",
    workers: [SOLO],
    prompt: `/dash ${SOLO_DASH} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_DASH, {
      branch: `tugdash/${SOLO_DASH}`,
      bound_sessions: [SOLO],
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
      "Every task closed and the draft written — the join, offered on the same terms a planned dash's is. The join cell fills and the phase glyph turns over; nothing here distinguishes the two routes, because at the join there is nothing left to distinguish",
    workers: [SOLO],
    prompt: `/dash ${SOLO_DASH} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_DASH, {
      branch: `tugdash/${SOLO_DASH}`,
      bound_sessions: [SOLO],
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
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: SOLO_SUBJECT },
    }),
  },
  {
    key: "direct-listless",
    caption:
      "A dash with no documents at all — every dash cut before task lists existed, and any run that skipped writing one. The strip is the same two cells and the implement cell is bare, because there is nothing to divide it into. This is the one case that still reads a WORD where the others read numbers",
    workers: [SOLO],
    prompt: `/dash ${SOLO_DASH} ${SOLO_SUBJECT}`,
    branched: true,
    entry: entry(SOLO_DASH, {
      branch: `tugdash/${SOLO_DASH}`,
      bound_sessions: [SOLO],
      stage: "working",
      rounds: 2,
      files: BRANCH_FILES,
      worktree_dirty: true,
      draft: { fingerprint: "spike", updated_at: TOUCHED, message: SOLO_SUBJECT },
    }),
  },
];

// ---------------------------------------------------------------------------
// A join the base refuses — the wire as it is, and the wire as proposed
// ---------------------------------------------------------------------------

const BLOCKED_DASH = "durable-commits";
const BLOCKED_PATH = "tuglaws/design-decisions.md";
const OTHER = "5d2e9b10-0000-4000-8000-00000000a11c";
sessionNameStore.setName(OTHER, "ink anchor");
sessionTagStore.setTag(OTHER, "ink-anchor");

/** The blocker exactly as `join_blockers_from_detail` writes it today. */
const BASE_DIRT_TODAY: DashJoinBlockerWire = {
  kind: "base-dirt",
  detail: `Cannot join: the base worktree has uncommitted changes to files this dash also changed (${BLOCKED_PATH}). Commit or stash them first.`,
  paths: [BLOCKED_PATH],
};

/** A ready dash the preflight refused: every step done, the draft written, one blocker. */
const BLOCKED_ENTRY: DashChangesetEntry = entry(BLOCKED_DASH, {
  branch: `tugdash/${BLOCKED_DASH}`,
  bound_sessions: [SOLO],
  stage: "ready",
  steps: steps(6, null, 6),
  step_total: 6,
  documents: { plan: `${ROOT}/.tug/dashes/${BLOCKED_DASH}/plan.md` },
  task_list: true,
  rounds: 6,
  files: [
    {
      path: BLOCKED_PATH,
      git_status: "M",
      op: "write",
      origin: "dash",
      shared: false,
      last_touched: TOUCHED,
    },
  ],
  base_overlap: [BLOCKED_PATH],
  last_replay: "replayed",
  draft: { fingerprint: "spike", updated_at: TOUCHED, message: "Doctrine and integration checks for durable commits" },
  join: { phase: "blocked", blockers: [BASE_DIRT_TODAY] },
});

const RESOLVE_IDLE: ResolveState = { phase: "idle", progress: [], error: null };

/**
 * PROPOSED — what one overlap path would carry, beyond its name.
 *
 * `owner` is the changes ledger's attribution of the base's dirt, the same
 * bucketing `app-test-changed` selects by. `relation` is a byte comparison of
 * the base's working copy against the dash's version of the path. Neither is
 * on the wire today; both are already computable server-side without a new
 * git call on the recompute's hot path.
 */
interface ProposedOverlap {
  path: string;
  owner: "mine" | "foreign" | "unattributed";
  /** Who, when `owner` is `foreign`. */
  holder?: string;
  /** `identical` — the base copy IS the dash's edit; `divergent` — it is other work. */
  relation: "identical" | "contained" | "divergent";
}

/**
 * PROPOSED — the one way out of a blocker, and the sentence that explains it.
 *
 * The remedy is not in the button. The sentence says what Resolve will do,
 * in the server's words; the button does it. A blocker nobody at this card
 * can clear still carries the sentence — it says whose turn it is — and its
 * button is disabled wearing that reason ([L31]).
 */
interface ProposedRemedy {
  /** What Resolve does, as one sentence the reader can weigh before pressing. */
  explain: string;
  /** Why the button is disabled, or null when it is live. */
  refused: string | null;
  /** What the register reads while the resolve runs. */
  running: string;
}

/** PROPOSED — a `base-dirt` blocker that carries its facts and its way out. */
interface ProposedBlocker extends DashJoinBlockerWire {
  overlap: ProposedOverlap[];
  remedy: ProposedRemedy;
}

/** The three situations one `base-dirt` bit hides, and what each deserves. */
interface Situation {
  key: string;
  title: string;
  caption: string;
  blocker: ProposedBlocker;
  /** The register's proposed word, where today all three read `blocked`. */
  word: string;
}

const SITUATIONS: readonly Situation[] = [
  {
    key: "stale-copy",
    title: "A · the base holds the dash's own edit",
    word: "blocked · resolvable",
    caption:
      "The likeliest case, and the one in the screenshot this proposal answers. Main's uncommitted copy of the file is the edit the dash already made, byte for byte — written on main from the dash's notes, or left behind when the dash was cut. Nothing is lost by dropping it, because the dash lands the same bytes. The server can say so only because it compared them, which is what makes this button safe to offer",
    blocker: {
      kind: "base-dirt",
      detail: `Cannot join: main has an uncommitted copy of ${BLOCKED_PATH} that this dash already carries.`,
      paths: [BLOCKED_PATH],
      overlap: [{ path: BLOCKED_PATH, owner: "mine", relation: "identical" }],
      remedy: {
        explain: "Main's copy is the dash's own edit. Resolve drops it and joins; nothing is lost.",
        refused: null,
        running: "resolving · dropping main's copy",
      },
    },
  },
  {
    key: "own-work",
    title: "B · your own live work on main",
    word: "blocked · resolvable",
    caption:
      "This session edited the file on main while the dash was running, and the two versions differ. The unblocking is mechanical; the merging is not — and the merging is a job the join already has an AI for. Resolve folds the main edit into the join (git's autostash shape underneath), and if the fold conflicts, that is an ordinary join conflict, handled by the resolver ladder where join conflicts are handled today — replay, rerere, merge-file, driver, then the AI with its intent questions. The user's work is never committed behind their back and never hidden: it rides the join and lands with it",
    blocker: {
      kind: "base-dirt",
      detail: `Cannot join: your uncommitted edit to ${BLOCKED_PATH} on main differs from this dash's version of it.`,
      paths: [BLOCKED_PATH],
      overlap: [{ path: BLOCKED_PATH, owner: "mine", relation: "divergent" }],
      remedy: {
        explain: "Resolve folds your main edit into the join. If the two versions conflict, the resolver reconciles them as it would any join conflict.",
        refused: null,
        running: "resolving · folding in your main edit",
      },
    },
  },
  {
    key: "foreign",
    title: "C · another live session's work",
    word: "blocked · held by ^ink-anchor",
    caption:
      "The changes ledger attributes the base's dirt to another session that is still live. Nothing here is this user's to move, and a button that folded another session's half-written edit into this join would be a button that breaks somebody else's work. So the frame is the same shape with the button disabled, wearing the reason — whose turn it is, rather than whose fault. When that session commits or discards its edit the blocker clears on its own, the register flips, and the button comes back",
    blocker: {
      kind: "base-dirt",
      detail: `Cannot join: ^ink-anchor holds an uncommitted edit to ${BLOCKED_PATH} that this dash also changed.`,
      paths: [BLOCKED_PATH],
      overlap: [{ path: BLOCKED_PATH, owner: "foreign", holder: "ink-anchor", relation: "divergent" }],
      remedy: {
        explain: "That edit belongs to ^ink-anchor. When it is committed or set aside there, this join unblocks by itself.",
        refused: "Held by ^ink-anchor",
        running: "",
      },
    },
  },
];

/**
 * The session-scoped binding, projected from the entry exactly as
 * `dashSessionIndex` projects it — so the masthead is reading the same object
 * the two blocks beside it are.
 */
function factFor(m: Moment): DashSessionFact {
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

function Stage({ caption, children }: { caption: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="cg-dash-stage">
      <TugLabel size="2xs" emphasis="calm" className="cg-dash-caption">
        {caption}
      </TugLabel>
      {children}
    </section>
  );
}

function Worker({ sessionId, register }: { sessionId: string; register: AtomRegister }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return <TugSessionIdentity identity={identity} tier="chip" register={register} dash={false} tooltip={false} />;
}

const AT_WORK = MOMENTS[3]!;

/**
 * A plan of `total` steps, `current` in progress — the fixture for the one
 * claim a single moment cannot make: that the strip is the same width at three
 * steps and at twenty-four.
 */
function planOf(total: number, current: number): DashTrackModel {
  return dashTrackModel({
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
const OUT_OF_ORDER: DashTrackModel = dashTrackModel({
  documents: { brief: BRIEF, plan: PLAN },
  arc: { stage: "implement" },
  stage: "implementing",
  steps: (["done", "done", "done", "in progress", "done", "pending"] as const).map((status, i) => ({
    title: `Step ${i + 1}`,
    status,
  })),
});

/**
 * PROPOSED — the blocked report section: the refusal, what Resolve does,
 * and Resolve. Three lines the reader can take in at a glance, in that order,
 * because the button is the last thing to read and the first thing to press.
 *
 * On this card a press walks the register through the resolve it would run —
 * running, then ready — since the verb behind it is proposal. The button
 * therefore has a visible result rather than none ([L31]), and the frame
 * shows what the row reads at each beat.
 */
function ProposedResolve({ situation }: { situation: Situation }): React.ReactElement {
  const { blocker, word } = situation;
  const { remedy } = blocker;
  const [beat, setBeat] = React.useState<"blocked" | "running" | "ready">("blocked");
  const register = beat === "blocked" ? word : beat === "running" ? remedy.running : "ready to join";
  return (
    <div className="cg-dash-remedies" data-slot="cg-dash-remedies" data-beat={beat}>
      <div className="cg-dash-legend-row">
        <span className="cg-dash-legend-word">register reads</span>
        <span className="cg-dash-register-word" data-beat={beat}>
          {register}
        </span>
      </div>
      <TugSectionLabel label={{ name: "report", qualifier: "proposed" }} />
      {beat === "ready" ? (
        <div className="cg-dash-remedy-explain" role="status">
          Resolved. The shade is raised on the ready dash, and the send button is Join.
        </div>
      ) : (
        <>
          <div className="session-changes-dash-join-detail cg-dash-remedy-detail">{blocker.detail}</div>
          <div className="cg-dash-remedy-explain">{remedy.explain}</div>
          <div className="cg-dash-remedy-row">
            <TugPushButton
              size="xs"
              emphasis="tinted"
              role="action"
              disabled={remedy.refused !== null || beat === "running"}
              loading={beat === "running"}
              onClick={() => {
                setBeat("running");
                window.setTimeout(() => setBeat("ready"), 1400);
              }}
            >
              Resolve
            </TugPushButton>
            {remedy.refused !== null ? (
              <span className="cg-dash-remedy-note">{remedy.refused}</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

const NO_JOIN_ACTIONS = { aim: () => {}, answerQuestion: () => {} };

export function GalleryDashLifecycle(): React.ReactElement {
  return (
    <div className="cg-content" data-testid="gallery-dash-lifecycle">
      <section className="cg-section">
        <TugLabel className="cg-section-title">The atom, once — TugDashAtom</TugLabel>
        <Stage caption="One skin, two registers (prose in a line of running text · reading in a block), proportional everywhere; who is on it is the atom beside it. A direct dash is a dash to the atom: both are work on a worktree">
          <div className="cg-dash-lineup">
            <TugDashAtom name={DASH} register="prose" />
            <TugDashAtom name={DASH} register="reading" />
            <span className="cg-dash-pair">
              <Worker sessionId={WORKER} register="reading" />
              <TugDashAtom name={DASH} register="reading" />
            </span>
            <TugDashAtom name="lens-none-empty" register="reading" />
          </div>
        </Stage>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">The lifecycle, as one track — TugDashTrack</TugLabel>
        <Stage caption="brief · devise · review · implement (one tick per step) · join. Each row is the real DashLifecycleLine, so the strip, the glyph, the fraction, and the word are spaced by the component rather than by this card. Cap-height, so it rides any line the atom is on. The type runs sit on one baseline and the two graphics are centred, which lands the cap-height strip on the type's own cap band; the glyph is sized a pixel proud of that band rather than four, so it reads as the strip's neighbour. What is behind you is a FILL and what is ahead is an OUTLINE: done is the muted text tone, active the theme's key color — the tone the pulsing dot uses for the same claim — the join the theme's selection color, and pending no fill at all">
          <div className="cg-dash-legend">
            {MOMENTS.map((m) => {
              const model = dashTrackModelFromEntry(m.entry);
              return (
                <DashLifecycleLine
                  key={m.key}
                  model={model}
                  note={dashLifecycleNote(model)}
                  size="read"
                />
              );
            })}
          </div>
        </Stage>
        <Stage caption="CONSTANT WIDTH. The implement cell is three cells wide at every plan length and its ticks divide it — three steps, eight, twenty-four, and the strip is the same graphic. A cell that sized to its ticks made the strip's width a function of the plan's length, so it grew under the reader and, on a narrow row, grew into whatever was set beside it">
          <div className="cg-dash-legend">
            {[3, 8, 24].map((n) => (
              <div className="cg-dash-legend-row" key={n}>
                <TugDashTrack model={planOf(n, Math.ceil(n / 3))} size="read" />
                <span className="cg-dash-legend-word">{`${n}-step plan`}</span>
              </div>
            ))}
          </div>
        </Stage>
        <Stage caption="The division of labour. A dash counts its steps in the track and nowhere else; the cell it is IN breathes, on the pulsing dot's own 2s envelope — quick in, slow out — so a strip and a dot on one row read as one instrument. A stopped arc holds still">
          <div className="cg-dash-legend-row">
            <TugProgressIndicator variant="pulsing-dot" size={12} state="running" aria-hidden />
            <TugDashTrack model={dashTrackModelFromEntry(AT_WORK.entry)} size="read" />
            <span className="cg-dash-legend-word">on a dash — the bare phase dot, and the track</span>
          </div>
        </Stage>
        <Stage caption="OUT OF ORDER. Steps 1–3 done, 4 in hand, 5 closed early. Four steps are done, so a strip that painted `n <= done` would fill tick 4 while it is the live one — which is the one reading this instrument must never give. The ticks are positional: done is a set of positions, and the step in hand outranks the closed reading. The ledger now refuses the way this used to happen — a `done` on a step nobody started — so a batched round that closes two steps at its end opens and closes each in turn">
          <div className="cg-dash-legend-row">
            <TugDashTrack model={OUT_OF_ORDER} size="read" />
            <span className="cg-dash-legend-word">4/6 — the fourth tick breathes, the fifth is filled</span>
          </div>
        </Stage>
        <Stage caption="The same five phases as one glyph — DashPhaseMark. Keyed on the lifecycle PHASE, never on the git stage: a dash devising or reviewing a plan has no stage at all, which is how the mark that used to do this job came to be blank for the whole first half of a dash's life">
          <div className="cg-dash-legend-row">
            {MOMENTS.map((m) => (
              <DashPhaseMark key={m.key} model={dashTrackModelFromEntry(m.entry)} size={16} />
            ))}
            <span className="cg-dash-legend-word">brief · devise · review · implement · stopped · join · then the four direct readings</span>
          </div>
        </Stage>
        <p className="cg-dash-prose">
          The row's indicator is a bare phase dot for the whole of a dash. A second mark drawing the same step count in
          another geometry would be free to disagree whenever one of them lagged, so the track has the subject alone.
          A stop is the one fact that outranks it: the cell paints danger, it stops breathing, and the note says why, in
          the arc receipt's words.
        </p>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">The compact register — DashLifecycleMark</TugLabel>
        <Stage caption="one pill · glyph · fraction — the full register's own order, one scale down. That the dash is alive, where it is, and how far along, in a box that cannot grow. The pill leads because it is the mark that touches the identity run it follows. The dash's NAME is not here: both hosts render the identity's own ^<dash> immediately to its left, and a second spelling of a name already on the line is a second thing to keep in step">
          <div className="cg-dash-legend">
            {MOMENTS.map((m) => (
              <div className="cg-dash-legend-row" key={m.key}>
                <DashLifecycleMark
                  model={dashTrackModelFromEntry(m.entry)}
                  size="read"
                  name={m.entry.display_name}
                />
                <span className="cg-dash-legend-word">{m.caption}</span>
              </div>
            ))}
          </div>
        </Stage>
        <p className="cg-dash-prose">
          Two surfaces take this rather than the track, and they are the two where a SESSION is the subject and the dash
          is one fact about it: the session card's masthead title line, and the Lens's session rows. Both lead with a
          name that elides, and the strip beside an eliding name is a graphic competing with the thing the row is
          named for. The pill wears the track's own palette and breathes on the track's own cycle, so the two registers
          read as one grammar.
        </p>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">Z2 · the DASH cell — an instrument, not a graphic</TugLabel>
        <Stage caption="STATE's shape, exactly: a dot pinned to each edge of the value wrap and the reading centered between them. NUMBERS whenever there are numbers — the declared run, else the plan's own pair, so a reviewed plan reads 0/10 rather than a word. The word is only for a dash with no plan at all. The cell takes STATE's 18ch because it wears STATE's construction, and JOBS gives back exactly that, so the row's total is the same 80ch either way and every container rung keeps its measured value">
          {/* The real row class, so the cells sit in the row's own 10px font
              and endcap apparatus, and the real `data-dash` flag, so the
              widths under test are the ones the app applies. */}
          <div className="session-telemetry-status-row cg-dash-z2-row" data-dash="true">
            {MOMENTS.map((m) => {
              const model = dashTrackModelFromEntry(m.entry);
              const pair =
                dashEntryGlanceFraction(m.entry) ?? dashMarkFraction(model);
              const reading =
                pair !== null
                  ? `${pair.current}/${pair.total}`
                  : model.stopped !== null
                    ? "Stopped"
                    : model.direct
                      ? "Working"
                      : DASH_PHASE_LABELS[model.phase];
              const state = model.stopped !== null ? "aborted" : "running";
              return (
                <TugStatusCell key={m.key} priority="tasks" label="DASH">
                  <TugProgressIndicator variant="pulsing-dot" size={12} state={state} aria-hidden />
                  <span
                    className="session-telemetry-status-value"
                    data-slot="session-telemetry-dash-value"
                    aria-label={`dash ${m.entry.display_name}`}
                  >
                    {reading}
                  </span>
                  <TugProgressIndicator variant="pulsing-dot" size={12} state={state} aria-hidden />
                </TugStatusCell>
              );
            })}
          </div>
        </Stage>
        <p className="cg-dash-prose">
          The whole track lived in this cell for a while, retuned by four knob overrides to survive a 78px box, and it
          drew ticks a pixel wide — a graphic too small to read at the size it was drawn. The cell now says the one
          thing that changes while somebody watches, and the strip is one press away on this cell's own placard.
        </p>
      </section>
      <section className="cg-section">
        <TugLabel className="cg-section-title">In flight — on every surface, no surface taller</TugLabel>
        {MOMENTS.map((m) => {
          const model = dashTrackModelFromEntry(m.entry);
          const note = dashLifecycleNote(model);
          const stepTitle = m.entry.step_title ?? null;
          const facts = dashMetaFacts(m.entry);
          const name = m.entry.display_name;
          return (
            <Stage key={m.key} caption={m.caption}>
              <div className="cg-dash-surfaces">
                <div className="cg-dash-surface">
                  <span className="cg-dash-surface-name">Lens · DashLifecycleBlock size=rail</span>
                  <TugListRow variant="flush" density="compact">
                    <DashLifecycleBlock name={name} workers={m.workers} model={model} note={note} stepTitle={stepTitle} facts={facts} size="rail" />
                  </TugListRow>
                </div>
                <div className="cg-dash-surface">
                  <span className="cg-dash-surface-name">Changes shade · DashLifecycleBlock size=read</span>
                  <DashLifecycleBlock name={name} workers={m.workers} model={model} note={note} stepTitle={stepTitle} facts={facts} size="read" />
                </div>
                <div className="cg-dash-surface" data-wide="true">
                  <span className="cg-dash-surface-name">Masthead · the real SessionIdentityRow, at SessionMasthead's settings</span>
                  <SessionIdentityRow
                    className="cg-dash-masthead-row"
                    sessionId={m.workers[0] ?? WORKER}
                    projectDir={ROOT}
                    dash={factFor(m)}
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
        <TugLabel className="cg-section-title">Blocked — a join the base refuses, today</TugLabel>
        <Stage caption="The shipping reading, off one wire entry with `join.phase = blocked` and one `base-dirt` blocker. The Lens row and the shade row both mount the real DashJoinRegister, which takes `blockers[0].detail` as its line; the shade's fold mounts the real SessionChangesDashJoin, whose blocker list renders the same sentence over the act that clears it — as a SPAN. That is the whole of what the surface offers: a sentence naming two acts, commit and stash, that no control on it can perform, one of which (stash) Tug has no affordance for anywhere, and which the server's own docblock calls the wrong advice for the likeliest case">
          <div className="cg-dash-surfaces">
            <div className="cg-dash-surface">
              <span className="cg-dash-surface-name">Lens · DashLifecycleBlock size=rail + DashJoinRegister</span>
              <TugListRow variant="flush" density="compact">
                <DashLifecycleBlock
                  name={BLOCKED_DASH}
                  workers={[SOLO]}
                  model={dashTrackModelFromEntry(BLOCKED_ENTRY)}
                  note={dashLifecycleNote(dashTrackModelFromEntry(BLOCKED_ENTRY))}
                  facts={dashMetaFacts(BLOCKED_ENTRY)}
                  size="rail"
                />
              </TugListRow>
              <span className="lens-dashes-register">
                <DashJoinRegister
                  dash={BLOCKED_DASH}
                  base="main"
                  stage={BLOCKED_ENTRY.stage}
                  join={BLOCKED_ENTRY.join}
                  bound
                  altitude="section"
                />
              </span>
            </div>
            <div className="cg-dash-surface">
              <span className="cg-dash-surface-name">Changes shade · the register, then the fold's report section</span>
              <DashLifecycleBlock
                name={BLOCKED_DASH}
                workers={[SOLO]}
                model={dashTrackModelFromEntry(BLOCKED_ENTRY)}
                note={dashLifecycleNote(dashTrackModelFromEntry(BLOCKED_ENTRY))}
                facts={dashMetaFacts(BLOCKED_ENTRY)}
                size="read"
              />
              <span className="session-changes-dash-register">
                <DashJoinRegister
                  dash={BLOCKED_DASH}
                  base="main"
                  stage={BLOCKED_ENTRY.stage}
                  join={BLOCKED_ENTRY.join}
                  bound
                  altitude="entry"
                />
              </span>
              <SessionChangesDashJoin
                entry={BLOCKED_ENTRY}
                join={BLOCKED_ENTRY.join ?? null}
                error={null}
                resolve={RESOLVE_IDLE}
                actions={NO_JOIN_ACTIONS}
              />
            </div>
          </div>
        </Stage>
        <p className="cg-dash-prose">
          The row's actions menu offers Bind, Discard and Replay — none of which clears the block. The Lens shows only the
          first blocker; a dash that is off-base and dirty at once hides its second refusal. And every situation
          below reads the same single word, <em>blocked</em>, because the wire carries one bit where there are three
          facts.
        </p>
      </section>

      <section className="cg-section">
        <TugLabel className="cg-section-title">Proposed — one sentence, one Resolve</TugLabel>
        <Stage caption="One `base-dirt` bit hides three situations, and every fact that tells them apart is already in hand: the changes ledger attributes the base's dirt to a session, and comparing the base copy's bytes against the dash's version says whether it is the dash's own edit or other work. The server composes the blocker with its one remedy, and the report section reads in three lines: what is wrong, what Resolve will do, Resolve. The remedy is never in the button — the sentence carries it, so the reader weighs it before pressing — and the button is always the same word. The unblocking is mechanical in every case; where judgment is needed, at the merge, the join's own resolver ladder already supplies it. Press Resolve to walk the register through the beats">
          <div className="cg-dash-situations">
            {SITUATIONS.map((s) => (
              <div className="cg-dash-surface" key={s.key}>
                <span className="cg-dash-surface-name">{s.title}</span>
                <TugLabel size="2xs" emphasis="calm" className="cg-dash-caption">
                  {s.caption}
                </TugLabel>
                <ProposedResolve situation={s} />
              </div>
            ))}
          </div>
        </Stage>
        <p className="cg-dash-prose">
          Resolve is one server verb, <code>dash resolve-base &lt;name&gt;</code>, that does the one thing the blocker's
          facts permit: an identical copy is dropped; a divergent one of the user's own is folded into the join, and a
          conflict from the fold enters the resolver ladder like any other; a foreign one is refused by name. It is
          op-logged, so <code>dash undo</code> puts main's copy back. The join then runs on the same press — Resolve is
          not a step before the join, it is the join with the block cleared — and the card's existing quiet-moment
          reveal raises the shade on the ready dash. "Commit or stash them first" retires, and no surface says{" "}
          <em>stash</em> again.
        </p>
        <p className="cg-dash-prose">
          Case A may not need the button at all: a base copy that is byte-identical to what the dash lands is an echo,
          not dirt, and the preflight could pass it with a line in the receipt. The frame keeps the button so the three
          cases read as one grammar; whether A collapses to zero is the first thing to decide. The order to build it:
          the Rust facts and verb with a test per owner × relation; the shade's report section; the Lens register
          word; the reveal memory's blocked→ready edge; one app-test per case over a real dash fixture with a dirtied
          base, ending on the shade raised.
        </p>
      </section>
    </div>
  );
}
