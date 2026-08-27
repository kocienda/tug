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
 */

import "./gallery-dash-lifecycle.css";

import React from "react";

import { DashLifecycleBlock } from "@/components/tugways/dash-lifecycle-block";
import { DashLifecycleLine, dashLifecycleNote } from "@/components/tugways/dash-lifecycle-line";
import { DashLifecycleMark, dashMarkFraction } from "@/components/tugways/dash-lifecycle-mark";
import { DashPhaseMark } from "@/components/tugways/dash-phase-mark";

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

import type { DashChangesetEntry, DashStep } from "@/lib/changeset-types";
import type { DashSessionFact } from "@/lib/dash-session-index";
import { useSessionIdentity } from "@/lib/session-identity";
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

function Worker({ sessionId, size }: { sessionId: string; size: "sm" | "2xs" }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return <TugSessionIdentity identity={identity} tier="chip" size={size} dash={false} tooltip={false} />;
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

export function GalleryDashLifecycle(): React.ReactElement {
  return (
    <div className="cg-content" data-testid="gallery-dash-lifecycle">
      <section className="cg-section">
        <TugLabel className="cg-section-title">The atom, once — TugDashAtom</TugLabel>
        <Stage caption="One skin, two sizes (rail 2xs · reading sm), proportional everywhere; who is on it is the atom beside it. A direct dash is a dash to the atom: both are work on a worktree">
          <div className="cg-dash-lineup">
            <TugDashAtom name={DASH} size="2xs" />
            <TugDashAtom name={DASH} size="sm" />
            <span className="cg-dash-pair">
              <Worker sessionId={WORKER} size="sm" />
              <TugDashAtom name={DASH} size="sm" />
            </span>
            <TugDashAtom name="lens-none-empty" size="sm" />
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
    </div>
  );
}
